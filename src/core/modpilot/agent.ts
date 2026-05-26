import { chatTurn } from './llm';
import type { GeminiMessage } from './llm';
import { executeTool, getFunctionDeclarations, getToolCategory } from './tools';
import type { ToolContext } from './tools';
import {
  appendMessage,
  bumpTurn,
  clearInterrupt,
  clearPendingApproval,
  clearPreamble,
  getApprovalMode,
  getHistory,
  getPendingApproval,
  getRunStatus,
  getSession,
  isInterrupted,
  markPreambleSent,
  pushEvent,
  resetTurns,
  setPendingApproval,
  setRunStatus,
  setSessionTitle,
  wasPreambleSent,
} from './session';
import { buildSystemPrompt } from './prompt';

// Not a workflow budget — a runaway circuit breaker. The moderator's stop button
// is the real control now; this only exists so a model stuck in an infinite loop
// can't burn unbounded Gemini cost if the moderator walks away. Set high enough
// that no legitimate multi-step workflow ever reaches it.
const HARD_TURN_CEILING = 200;

// History compaction (context Option 1): the full conversation is re-sent to
// Gemini every turn, and old tool-result `data` payloads are the bulk of it. We
// keep the most recent KEEP_RECENT_RESULTS tool results intact (the model is
// actively reasoning over those) and strip the heavy `data` from older ones,
// preserving `ok`/`summary`/`error` so the model still knows what each call did.
// This is applied to a COPY just before sending — the stored history in Redis
// stays full, so nothing is permanently lost and a re-load re-derives the same
// compaction.
const KEEP_RECENT_RESULTS = 6;

// Hard cap on how many trailing messages we SEND to Gemini. The full history is
// re-sent every turn, so a long-lived chat balloons the prompt — slow, costly,
// and past a point the model starts parroting its own old replies instead of
// acting. We send only the last MAX_SENT_MESSAGES, trimmed to a clean 'user'
// boundary so we never ship a functionResponse whose functionCall was cut.
// Redis history stays full; this only shrinks the per-turn payload.
const MAX_SENT_MESSAGES = 60;

type ToolCall = { name: string; args: Record<string, unknown> };
type ExecOutcome = 'completed' | 'suspended';

function nowTs() {
  return Date.now();
}

function newToolCallId() {
  return `tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

// Heuristic for the no-op guard: does this text ANNOUNCE a mutation it intends to
// make (future tense) while having emitted no tool calls? Past-tense summaries
// ("Removed 5 posts") and plain answers don't match, so genuine final replies
// pass through untouched.
const PENDING_INTENT_RE =
  /\b(i['’ ]?ll|i will|i am going to|i'?m going to|let me|going to|proceed to|now i)\b/i;
const MUTATION_WORD_RE =
  /\b(remov|ban\b|lock|delet|approv|report|repl(y|ies)|sticky|distinguish|mod[- ]?note|modmail)/i;
function looksLikePendingAction(text: string): boolean {
  return PENDING_INTENT_RE.test(text) && MUTATION_WORD_RE.test(text);
}

// Cap the SENT history to the last MAX_SENT_MESSAGES, starting on a clean 'user'
// turn boundary so we never ship a functionResponse whose functionCall was
// trimmed off the front (Gemini rejects an orphaned response). Non-destructive.
function capHistory(history: GeminiMessage[]): GeminiMessage[] {
  if (history.length <= MAX_SENT_MESSAGES) return history;
  const cutoff = history.length - MAX_SENT_MESSAGES;
  let start = cutoff;
  while (start < history.length && history[start]!.role !== 'user') start++;
  if (start >= history.length) {
    // No user boundary in the tail — at least skip leading function responses so
    // the window doesn't open on an orphaned functionResponse.
    start = cutoff;
    while (start < history.length && history[start]!.role === 'function') start++;
  }
  return history.slice(start);
}

// Return a send-ready copy: cap the message count, then strip old tool-result
// `data` payloads (keeping the last KEEP_RECENT_RESULTS intact). Non-destructive:
// only the messages/parts being stubbed are cloned; the input array is untouched.
function compactHistoryForSend(history: GeminiMessage[]): {
  messages: GeminiMessage[];
  stubbed: number;
  dropped: number;
} {
  const capped = capHistory(history);
  const dropped = history.length - capped.length;
  const out = capped.slice();
  let seenResults = 0;
  let stubbed = 0;

  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i]!;
    let cloned: GeminiMessage | null = null;

    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j]!;
      if (!('functionResponse' in part)) continue;

      seenResults++;
      if (seenResults <= KEEP_RECENT_RESULTS) continue;

      const resp = part.functionResponse.response as Record<string, unknown>;
      if (!resp || resp.data === undefined || resp.elided === true) continue;

      if (!cloned) {
        cloned = { role: msg.role, parts: msg.parts.slice() };
        out[i] = cloned;
      }
      const stub: Record<string, unknown> = {
        ok: resp.ok,
        summary: resp.summary,
        elided: true,
      };
      if (resp.error !== undefined) stub.error = resp.error;
      cloned.parts[j] = {
        functionResponse: { name: part.functionResponse.name, response: stub },
      };
      stubbed++;
    }
  }

  return { messages: out, stubbed, dropped };
}

// Deliver the final text in one event. Devvit's fetch is buffered (no real token
// stream from Gemini) and the client polls rather than holding an SSE socket, so
// faking cadence server-side is pointless — the CLIENT animates the reveal with a
// requestAnimationFrame typewriter instead, which looks like real streaming.
async function streamText(sessionId: string, text: string): Promise<void> {
  await pushEvent(sessionId, { type: 'text_chunk', text, ts: nowTs() });
}

// ---------- entry points ----------

export async function runAgent(args: { sessionId: string; userMessage: string }): Promise<void> {
  const { sessionId, userMessage } = args;
  const tag = `[modpilot:agent ${sessionId}]`;

  const meta = await getSession(sessionId);
  if (!meta) {
    console.warn(`${tag} session not found`);
    await pushEvent(sessionId, { type: 'error', message: 'Session not found.', ts: nowTs() });
    return;
  }

  const existing = await getRunStatus(sessionId);
  if (existing === 'running') {
    console.warn(`${tag} refused: already running`);
    await pushEvent(sessionId, {
      type: 'error',
      message: 'A previous request is still running on this chat. Wait for it to finish.',
      ts: nowTs(),
    });
    return;
  }
  if (existing === 'awaiting_approval') {
    console.warn(`${tag} refused: awaiting approval`);
    await pushEvent(sessionId, {
      type: 'error',
      message: 'Resolve the pending action approval before sending another message.',
      ts: nowTs(),
    });
    return;
  }

  await setRunStatus(sessionId, 'running');
  await resetTurns(sessionId);
  await clearInterrupt(sessionId); // drop any stale stop signal from a prior run
  await clearPreamble(sessionId); // re-arm the one lead-in line for this message
  console.log(
    `${tag} START | u/${meta.username} on r/${meta.subreddit} | mode=${meta.approvalMode} | msg: ${truncate(userMessage, 120)}`
  );

  await pushEvent(sessionId, { type: 'user_message', text: userMessage, ts: nowTs() });
  await appendMessage(sessionId, { role: 'user', parts: [{ text: userMessage }] });

  const initialHistory = await getHistory(sessionId);
  if (initialHistory.length === 1) {
    await setSessionTitle(sessionId, truncate(userMessage, 60));
  }

  const ctx: ToolContext = { subreddit: meta.subreddit, actor: meta.username };
  try {
    await driveLoop(sessionId, ctx, tag);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${tag} EXCEPTION ${msg}`, e);
    await pushEvent(sessionId, { type: 'error', message: msg, ts: nowTs() });
    await setRunStatus(sessionId, 'error');
  }
}

export async function resumeApproval(args: {
  sessionId: string;
  decision: 'approve' | 'reject';
}): Promise<void> {
  const { sessionId, decision } = args;
  const tag = `[modpilot:agent ${sessionId}]`;

  const meta = await getSession(sessionId);
  if (!meta) {
    await pushEvent(sessionId, { type: 'error', message: 'Session not found.', ts: nowTs() });
    return;
  }
  const pending = await getPendingApproval(sessionId);
  if (!pending) {
    console.warn(`${tag} resume: no pending approval`);
    return;
  }
  await clearPendingApproval(sessionId);
  await setRunStatus(sessionId, 'running');
  console.log(`${tag} resume: ${decision} ${pending.name} (${pending.callId})`);

  await pushEvent(sessionId, {
    type: 'tool_approval_resolved',
    id: pending.callId,
    decision,
    ts: nowTs(),
  });

  const ctx: ToolContext = { subreddit: meta.subreddit, actor: meta.username };
  try {
    if (decision === 'approve') {
      await executeOne(sessionId, ctx, { name: pending.name, args: pending.args }, tag, pending.callId);
    } else {
      await recordRejection(sessionId, pending, tag);
    }

    // Finish any sibling calls from the same model turn, then continue.
    const outcome = await executeCalls(sessionId, ctx, pending.queuedCalls, tag);
    if (outcome === 'suspended') return;
    await driveLoop(sessionId, ctx, tag);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${tag} resume EXCEPTION ${msg}`, e);
    await pushEvent(sessionId, { type: 'error', message: msg, ts: nowTs() });
    await setRunStatus(sessionId, 'error');
  }
}

// ---------- core loop ----------

async function driveLoop(sessionId: string, ctx: ToolContext, tag: string): Promise<void> {
  const systemPrompt = buildSystemPrompt(ctx);
  const tools = getFunctionDeclarations();
  let noopNudges = 0; // no-op guard: at most one nudge per run, to avoid loops
  let malformedRetries = 0; // MALFORMED_FUNCTION_CALL retries, bounded

  for (;;) {
    // Cooperative stop: the moderator hit the stop button. Bail before spending
    // another model turn. Latency is at most one in-flight turn.
    if (await isInterrupted(sessionId)) {
      await clearInterrupt(sessionId);
      console.log(`${tag} STOP — interrupted by moderator`);
      await pushEvent(sessionId, { type: 'stopped', ts: nowTs() });
      await setRunStatus(sessionId, 'done');
      return;
    }

    const turn = await bumpTurn(sessionId);
    if (turn > HARD_TURN_CEILING) {
      console.warn(`${tag} STOP — hit HARD_TURN_CEILING=${HARD_TURN_CEILING} (runaway circuit breaker)`);
      await pushEvent(sessionId, {
        type: 'error',
        message: `Stopped after ${HARD_TURN_CEILING} turns — likely a loop. Use the stop button or rephrase.`,
        ts: nowTs(),
      });
      await setRunStatus(sessionId, 'error');
      return;
    }

    const hist = await getHistory(sessionId);
    const { messages: sendHist, stubbed, dropped } = compactHistoryForSend(hist);
    console.log(
      `${tag} turn ${turn}/${HARD_TURN_CEILING} — history ${hist.length} msgs` +
        (dropped > 0 ? `, sent last ${hist.length - dropped} (capped ${dropped})` : '') +
        (stubbed > 0 ? `, stubbed ${stubbed} old payload(s)` : '')
    );
    const result = await chatTurn(sendHist, tools, systemPrompt, `${sessionId}#${turn}`);

    // A turn that makes tool calls. The model's accompanying prose is a lead-in
    // ("about to do X"): surface it ONCE — on the first tool-bearing turn of the
    // message — so the moderator sees intent before actions fire. On every later
    // tool turn the prose is DROPPED (not streamed, not stored): "act, don't
    // narrate" — no mid-loop play-by-play. The final pure-text turn below writes
    // the one closing summary once all actions are done.
    if (result.functionCalls.length > 0) {
      const preface = (result.text ?? '').trim();
      const showPreface = preface.length > 0 && !(await wasPreambleSent(sessionId));
      const parts: GeminiMessage['parts'] = [];
      if (showPreface) {
        await markPreambleSent(sessionId);
        console.log(`${tag} turn ${turn} — preamble (${preface.length} chars). Streaming.`);
        await streamText(sessionId, preface);
        parts.push({ text: preface }); // keep in history so the model won't re-lead-in
      }
      for (const fc of result.functionCalls) {
        parts.push({ functionCall: { name: fc.name, args: fc.args } });
      }
      await appendMessage(sessionId, { role: 'model', parts });
      const outcome = await executeCalls(sessionId, ctx, result.functionCalls, tag);
      if (outcome === 'suspended') return;
      continue;
    }

    // Pure text final reply.
    const text = result.text ?? '';
    if (!text) {
      // MALFORMED_FUNCTION_CALL: the model tried to call tools but produced output
      // Gemini couldn't parse — usually from cramming too many calls into one turn.
      // Retry (bounded) with a "fewer calls" nudge instead of dead-ending.
      if (result.finishReason === 'MALFORMED_FUNCTION_CALL' && malformedRetries < 2) {
        malformedRetries++;
        console.warn(`${tag} turn ${turn} — MALFORMED_FUNCTION_CALL; retry ${malformedRetries}/2`);
        await appendMessage(sessionId, {
          role: 'user',
          parts: [
            {
              text:
                'Your previous tool call was malformed — likely too many calls at once. ' +
                'Re-issue now with valid JSON arguments and AT MOST 8 tool calls this turn; ' +
                'handle any remaining items on later turns.',
            },
          ],
        });
        continue;
      }
      const why =
        result.finishReason === 'MALFORMED_FUNCTION_CALL'
          ? 'The model kept producing a malformed tool call (often too many actions at once). Try a smaller batch or rephrase.'
          : 'The model returned an empty response. Try rephrasing.';
      console.warn(`${tag} turn ${turn} — empty result (finishReason=${result.finishReason}). Bailing.`);
      await pushEvent(sessionId, { type: 'error', message: why, ts: nowTs() });
      await setRunStatus(sessionId, 'error');
      return;
    }

    // No-op guard: the model described a mutation it intends to make but emitted
    // no tool calls, so nothing happened. Don't finalize on that dead-end — nudge
    // it once to actually issue the calls. Gated by intent phrasing (genuine
    // answers pass through) and capped at one nudge per run (no infinite loop).
    // The narration is NOT streamed to the user; only kept in history for context.
    if (noopNudges < 1 && looksLikePendingAction(text)) {
      noopNudges++;
      console.warn(`${tag} turn ${turn} — no-op guard: described actions, no tool calls. Nudging.`);
      await appendMessage(sessionId, { role: 'model', parts: [{ text }] });
      await appendMessage(sessionId, {
        role: 'user',
        parts: [
          {
            text:
              'You described actions you intend to take but issued NO tool calls, so nothing actually happened. ' +
              'Issue the real tool calls now to perform them — do not describe them again.',
          },
        ],
      });
      continue;
    }

    console.log(`${tag} turn ${turn} — final text (${text.length} chars). Streaming.`);
    await appendMessage(sessionId, { role: 'model', parts: [{ text }] });
    await streamText(sessionId, text);
    await pushEvent(sessionId, { type: 'assistant_done', ts: nowTs() });
    await setRunStatus(sessionId, 'done');
    console.log(`${tag} DONE on turn ${turn}`);
    return;
  }
}

// Execute a list of calls in order. In manual mode, the first mutation parks
// for approval: we persist it + the remaining calls and suspend.
async function executeCalls(
  sessionId: string,
  ctx: ToolContext,
  calls: ToolCall[],
  tag: string
): Promise<ExecOutcome> {
  const mode = await getApprovalMode(sessionId);
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const cat = getToolCategory(call.name);

    if (cat === 'mutate' && mode === 'manual') {
      const callId = newToolCallId();
      const confirmation =
        typeof call.args.confirmation === 'string' ? call.args.confirmation : '';
      await setPendingApproval(sessionId, {
        callId,
        name: call.name,
        args: call.args,
        queuedCalls: calls.slice(i + 1),
        ts: nowTs(),
      });
      await pushEvent(sessionId, {
        type: 'tool_approval_request',
        id: callId,
        name: call.name,
        args: call.args,
        confirmation,
        ts: nowTs(),
      });
      await setRunStatus(sessionId, 'awaiting_approval');
      console.log(`${tag} ⏸ awaiting approval for ${call.name} (${callId})`);
      return 'suspended';
    }

    await executeOne(sessionId, ctx, call, tag);
  }
  return 'completed';
}

async function executeOne(
  sessionId: string,
  ctx: ToolContext,
  call: ToolCall,
  tag: string,
  preCallId?: string
): Promise<void> {
  const callId = preCallId ?? newToolCallId();
  const cat = getToolCategory(call.name);
  console.log(
    `${tag} → tool ${call.name} [${cat ?? '?'}] args=${JSON.stringify(call.args).slice(0, 300)}`
  );

  await pushEvent(sessionId, {
    type: 'tool_call',
    id: callId,
    name: call.name,
    args: call.args,
    ts: nowTs(),
  });
  if (cat === 'mutate') {
    await pushEvent(sessionId, { type: 'status', text: `Executing ${call.name}…`, ts: nowTs() });
  }

  const t0 = Date.now();
  const toolResult = await executeTool(call.name, call.args, ctx);
  const ms = Date.now() - t0;
  console.log(
    `${tag} ← tool ${call.name} ${toolResult.ok ? 'OK' : 'FAIL'} in ${ms}ms — ${toolResult.summary}`
  );
  if (toolResult.data !== undefined) {
    const dump = JSON.stringify(toolResult.data);
    console.log(`${tag}   data: ${dump.slice(0, 400)}${dump.length > 400 ? '…' : ''}`);
  }
  if (toolResult.error) console.log(`${tag}   error: ${toolResult.error}`);

  await pushEvent(sessionId, {
    type: 'tool_result',
    id: callId,
    name: call.name,
    ok: toolResult.ok,
    summary: toolResult.summary,
    data: toolResult.data,
    ts: nowTs(),
  });

  await appendMessage(sessionId, {
    role: 'function',
    parts: [
      {
        functionResponse: {
          name: call.name,
          response: {
            ok: toolResult.ok,
            summary: toolResult.summary,
            data: toolResult.data,
            error: toolResult.error,
          },
        },
      },
    ],
  });
}

// Record a moderator rejection as a tool result so the model learns the action
// did not happen and should not be retried.
async function recordRejection(
  sessionId: string,
  pending: { callId: string; name: string; args: Record<string, unknown> },
  tag: string
): Promise<void> {
  console.log(`${tag} ✗ rejected ${pending.name} (${pending.callId})`);
  await pushEvent(sessionId, {
    type: 'tool_result',
    id: pending.callId,
    name: pending.name,
    ok: false,
    summary: 'Rejected by moderator — action not taken.',
    ts: nowTs(),
  });
  await appendMessage(sessionId, {
    role: 'function',
    parts: [
      {
        functionResponse: {
          name: pending.name,
          response: {
            ok: false,
            summary: 'The moderator REJECTED this action in the approval UI. It was NOT executed.',
            error: 'rejected_by_moderator',
            note: 'Do not retry the same action. Acknowledge the rejection and ask how to proceed, or continue with other steps.',
          },
        },
      },
    ],
  });
}
