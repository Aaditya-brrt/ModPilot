import { chatTurn } from './llm';
import { executeTool, getFunctionDeclarations, getToolCategory } from './tools';
import type { ToolContext } from './tools';
import {
  appendMessage,
  bumpTurn,
  clearPendingApproval,
  getApprovalMode,
  getHistory,
  getPendingApproval,
  getRunStatus,
  getSession,
  pushEvent,
  resetTurns,
  setPendingApproval,
  setRunStatus,
  setSessionTitle,
} from './session';
import { buildSystemPrompt } from './prompt';

const MAX_TURNS = 8;
const STREAM_CHUNK_SIZE = 12;
const STREAM_CHUNK_DELAY_MS = 25;

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

function chunkText(s: string): string[] {
  const out: string[] = [];
  const words = s.split(/(\s+)/);
  let buf = '';
  for (const w of words) {
    buf += w;
    if (buf.length >= STREAM_CHUNK_SIZE) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

async function streamText(sessionId: string, text: string): Promise<void> {
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    await pushEvent(sessionId, { type: 'text_chunk', text: chunk, ts: nowTs() });
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, STREAM_CHUNK_DELAY_MS));
  }
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

  for (;;) {
    const turn = await bumpTurn(sessionId);
    if (turn > MAX_TURNS) {
      console.warn(`${tag} STOP — hit MAX_TURNS=${MAX_TURNS}`);
      await pushEvent(sessionId, {
        type: 'error',
        message: `Stopped after ${MAX_TURNS} turns — possible loop. Ask the model to wrap up.`,
        ts: nowTs(),
      });
      await setRunStatus(sessionId, 'error');
      return;
    }

    const hist = await getHistory(sessionId);
    console.log(`${tag} turn ${turn}/${MAX_TURNS} — history length ${hist.length}`);
    const result = await chatTurn(hist, tools, systemPrompt, `${sessionId}#${turn}`);

    // Mixed reply: text + calls. Stream the text, then run the calls.
    if (result.text && result.functionCalls.length > 0) {
      await appendMessage(sessionId, {
        role: 'model',
        parts: [
          { text: result.text },
          ...result.functionCalls.map((fc) => ({ functionCall: { name: fc.name, args: fc.args } })),
        ],
      });
      await streamText(sessionId, result.text);
      const outcome = await executeCalls(sessionId, ctx, result.functionCalls, tag);
      if (outcome === 'suspended') return;
      continue;
    }

    if (result.functionCalls.length > 0) {
      await appendMessage(sessionId, {
        role: 'model',
        parts: result.functionCalls.map((fc) => ({ functionCall: { name: fc.name, args: fc.args } })),
      });
      const outcome = await executeCalls(sessionId, ctx, result.functionCalls, tag);
      if (outcome === 'suspended') return;
      continue;
    }

    // Pure text final reply.
    const text = result.text ?? '';
    if (!text) {
      console.warn(`${tag} turn ${turn} — model returned NEITHER text NOR calls. Bailing.`);
      await pushEvent(sessionId, {
        type: 'error',
        message: 'The model returned an empty response. Try rephrasing.',
        ts: nowTs(),
      });
      await setRunStatus(sessionId, 'error');
      return;
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
