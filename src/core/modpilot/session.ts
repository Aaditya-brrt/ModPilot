import { redis } from '@devvit/web/server';
import type { GeminiMessage } from './llm';

export type ChatEvent =
  | { type: 'user_message'; text: string; ts: number }
  | { type: 'status'; text: string; ts: number }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown>; ts: number }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      data?: unknown;
      ts: number;
    }
  | {
      type: 'tool_approval_request';
      id: string;
      name: string;
      args: Record<string, unknown>;
      confirmation: string;
      ts: number;
    }
  | { type: 'tool_approval_resolved'; id: string; decision: 'approve' | 'reject'; ts: number }
  | { type: 'text_chunk'; text: string; ts: number }
  | { type: 'assistant_done'; ts: number }
  | { type: 'stopped'; ts: number }
  | { type: 'error'; message: string; ts: number };

export type ApprovalMode = 'auto' | 'manual';

export type RunStatus = 'idle' | 'running' | 'awaiting_approval' | 'done' | 'error';

// A mutation tool call parked for the moderator to approve/reject. `queuedCalls`
// are the remaining calls from the SAME model turn that still need to run once
// this one is resolved.
export type PendingApproval = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  queuedCalls: Array<{ name: string; args: Record<string, unknown> }>;
  ts: number;
};

export type SessionMeta = {
  sessionId: string;
  userId: string;
  username: string;
  subreddit: string;
  title: string;
  approvalMode: ApprovalMode;
  createdAt: number;
  updatedAt: number;
};

const SESSIONS_INDEX = (userId: string) => `modpilot:sessions:${userId}`;
const SESSION_META = (sessionId: string) => `modpilot:session:${sessionId}`;
const SESSION_MSGS = (sessionId: string) => `modpilot:session:${sessionId}:msgs`;
const SESSION_MSG_COUNT = (sessionId: string) => `modpilot:session:${sessionId}:msg_count`;
const SESSION_EVENTS = (sessionId: string) => `modpilot:session:${sessionId}:events`;
const SESSION_EVENT_COUNT = (sessionId: string) => `modpilot:session:${sessionId}:event_count`;
const SESSION_RUN = (sessionId: string) => `modpilot:session:${sessionId}:run`;
const SESSION_PENDING = (sessionId: string) => `modpilot:session:${sessionId}:pending`;
const SESSION_TURNS = (sessionId: string) => `modpilot:session:${sessionId}:turns`;
// Cooperative stop signal. The moderator's stop button sets it; the agent loop
// checks it between turns and bails. In Redis (not in-memory) because the stop
// request and the running loop may land on different Devvit invocations.
const SESSION_INTERRUPT = (sessionId: string) => `modpilot:session:${sessionId}:interrupt`;
// One-preamble-per-message flag. The model's lead-in prose ("about to do X") is
// surfaced only on the FIRST tool-bearing turn; this flag suppresses it on later
// tool turns (no mid-loop narration). In Redis so it survives the approval
// suspend/resume boundary, where driveLoop is re-entered on a fresh invocation.
const SESSION_PREAMBLE = (sessionId: string) => `modpilot:session:${sessionId}:preamble`;

export async function createSession(args: {
  userId: string;
  username: string;
  subreddit: string;
  title?: string;
}): Promise<SessionMeta> {
  const sessionId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const meta: SessionMeta = {
    sessionId,
    userId: args.userId,
    username: args.username,
    subreddit: args.subreddit,
    title: args.title ?? 'New chat',
    approvalMode: 'manual',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await redis.hSet(SESSION_META(sessionId), {
    sessionId,
    userId: args.userId,
    username: args.username,
    subreddit: args.subreddit,
    title: meta.title,
    approvalMode: meta.approvalMode,
    createdAt: String(meta.createdAt),
    updatedAt: String(meta.updatedAt),
  });
  await redis.zAdd(SESSIONS_INDEX(args.userId), {
    member: sessionId,
    score: meta.createdAt,
  });
  return meta;
}

export async function getSession(sessionId: string): Promise<SessionMeta | undefined> {
  const h = await redis.hGetAll(SESSION_META(sessionId));
  if (!h || !h.sessionId) return undefined;
  return {
    sessionId: h.sessionId,
    userId: h.userId ?? '',
    username: h.username ?? '',
    subreddit: h.subreddit ?? '',
    title: h.title ?? 'Chat',
    approvalMode: h.approvalMode === 'auto' ? 'auto' : 'manual',
    createdAt: Number(h.createdAt ?? 0),
    updatedAt: Number(h.updatedAt ?? 0),
  };
}

export async function getApprovalMode(sessionId: string): Promise<ApprovalMode> {
  const meta = await getSession(sessionId);
  return meta?.approvalMode ?? 'manual';
}

export async function setApprovalMode(sessionId: string, mode: ApprovalMode): Promise<void> {
  await redis.hSet(SESSION_META(sessionId), {
    approvalMode: mode,
    updatedAt: String(Date.now()),
  });
}

export async function listSessions(userId: string, limit = 20): Promise<SessionMeta[]> {
  const entries = await redis.zRange(SESSIONS_INDEX(userId), 0, limit - 1, {
    by: 'rank',
    reverse: true,
  });
  const out: SessionMeta[] = [];
  for (const e of entries) {
    const meta = await getSession(e.member);
    if (meta) out.push(meta);
  }
  return out;
}

export async function setSessionTitle(sessionId: string, title: string): Promise<void> {
  await redis.hSet(SESSION_META(sessionId), {
    title: title.slice(0, 80),
    updatedAt: String(Date.now()),
  });
}

export async function appendMessage(
  sessionId: string,
  message: GeminiMessage
): Promise<void> {
  const seq = await redis.incrBy(SESSION_MSG_COUNT(sessionId), 1);
  await redis.hSet(SESSION_MSGS(sessionId), {
    [String(seq)]: JSON.stringify(message),
  });
  await redis.hSet(SESSION_META(sessionId), { updatedAt: String(Date.now()) });
}

export async function getHistory(sessionId: string): Promise<GeminiMessage[]> {
  const map = await redis.hGetAll(SESSION_MSGS(sessionId));
  if (!map) return [];
  const sortedKeys = Object.keys(map)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const out: GeminiMessage[] = [];
  for (const k of sortedKeys) {
    const raw = map[String(k)];
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw) as GeminiMessage);
    } catch {
      // skip
    }
  }
  return out;
}

export async function pushEvent(sessionId: string, event: ChatEvent): Promise<number> {
  const seq = await redis.incrBy(SESSION_EVENT_COUNT(sessionId), 1);
  await redis.hSet(SESSION_EVENTS(sessionId), {
    [String(seq)]: JSON.stringify(event),
  });
  return seq;
}

export async function getEvents(
  sessionId: string,
  since: number
): Promise<{ events: ChatEvent[]; nextCursor: number }> {
  const map = await redis.hGetAll(SESSION_EVENTS(sessionId));
  if (!map) return { events: [], nextCursor: since };
  const keys = Object.keys(map)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > since)
    .sort((a, b) => a - b);
  const events: ChatEvent[] = [];
  let nextCursor = since;
  for (const k of keys) {
    const raw = map[String(k)];
    if (!raw) continue;
    try {
      events.push(JSON.parse(raw) as ChatEvent);
      nextCursor = k;
    } catch {
      // skip
    }
  }
  return { events, nextCursor };
}

export async function setRunStatus(sessionId: string, status: RunStatus): Promise<void> {
  await redis.set(SESSION_RUN(sessionId), status);
}

export async function getRunStatus(sessionId: string): Promise<RunStatus> {
  const v = await redis.get(SESSION_RUN(sessionId));
  switch (v) {
    case 'running':
    case 'awaiting_approval':
    case 'done':
    case 'error':
      return v;
    default:
      return 'idle';
  }
}

// ---------- pending approval (manual mutation gate) ----------

export async function setPendingApproval(
  sessionId: string,
  pending: PendingApproval
): Promise<void> {
  await redis.set(SESSION_PENDING(sessionId), JSON.stringify(pending));
}

export async function getPendingApproval(
  sessionId: string
): Promise<PendingApproval | undefined> {
  const raw = await redis.get(SESSION_PENDING(sessionId));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as PendingApproval;
  } catch {
    return undefined;
  }
}

export async function clearPendingApproval(sessionId: string): Promise<void> {
  await redis.del(SESSION_PENDING(sessionId));
}

// ---------- per-run turn counter (survives approval suspend/resume) ----------

export async function resetTurns(sessionId: string): Promise<void> {
  await redis.set(SESSION_TURNS(sessionId), '0');
}

export async function bumpTurn(sessionId: string): Promise<number> {
  return redis.incrBy(SESSION_TURNS(sessionId), 1);
}

// ---------- cooperative stop signal ----------

export async function setInterrupt(sessionId: string): Promise<void> {
  await redis.set(SESSION_INTERRUPT(sessionId), '1');
}

export async function isInterrupted(sessionId: string): Promise<boolean> {
  return (await redis.get(SESSION_INTERRUPT(sessionId))) === '1';
}

export async function clearInterrupt(sessionId: string): Promise<void> {
  await redis.del(SESSION_INTERRUPT(sessionId));
}

// ---------- one-preamble-per-message flag ----------

export async function markPreambleSent(sessionId: string): Promise<void> {
  await redis.set(SESSION_PREAMBLE(sessionId), '1');
}

export async function wasPreambleSent(sessionId: string): Promise<boolean> {
  return (await redis.get(SESSION_PREAMBLE(sessionId))) === '1';
}

export async function clearPreamble(sessionId: string): Promise<void> {
  await redis.del(SESSION_PREAMBLE(sessionId));
}
