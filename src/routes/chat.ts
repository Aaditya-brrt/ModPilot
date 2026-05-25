import { Hono } from 'hono';
import { reddit } from '@devvit/web/server';
import { resumeApproval, runAgent } from '../core/modpilot/agent';
import {
  clearInterrupt,
  clearPendingApproval,
  createSession,
  getEvents,
  getPendingApproval,
  getRunStatus,
  getSession,
  listSessions,
  pushEvent,
  setApprovalMode,
  setInterrupt,
  setRunStatus,
} from '../core/modpilot/session';

export const chat = new Hono();

async function requireMod(): Promise<{ ok: true; username: string; userId: string; subreddit: string } | { ok: false; error: string }> {
  const u = await reddit.getCurrentUser();
  if (!u) return { ok: false, error: 'must be signed in' };
  const sub = await reddit.getCurrentSubreddit();
  try {
    const mods = await reddit
      .getModerators({ subredditName: sub.name, username: u.username, limit: 1 })
      .all();
    if (mods.length === 0) return { ok: false, error: 'moderators only' };
    return { ok: true, username: u.username, userId: u.id, subreddit: sub.name };
  } catch (e) {
    return { ok: false, error: 'mod check failed: ' + String(e) };
  }
}

chat.post('/session', async (c) => {
  const auth = await requireMod();
  if (!auth.ok) return c.json({ ok: false, error: auth.error }, 403);
  try {
    const meta = await createSession({
      userId: auth.userId,
      username: auth.username,
      subreddit: auth.subreddit,
    });
    return c.json({ ok: true, session: meta });
  } catch (e) {
    console.error('[modpilot] create session failed', e);
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

chat.get('/sessions', async (c) => {
  const auth = await requireMod();
  if (!auth.ok) return c.json({ ok: false, error: auth.error, sessions: [] }, 403);
  try {
    const sessions = await listSessions(auth.userId, 30);
    return c.json({ ok: true, sessions });
  } catch (e) {
    return c.json({ ok: false, error: String(e), sessions: [] }, 500);
  }
});

chat.post('/:sessionId/message', async (c) => {
  const auth = await requireMod();
  if (!auth.ok) return c.json({ ok: false, error: auth.error }, 403);
  const sessionId = c.req.param('sessionId');
  let body: { text?: string };
  try {
    body = (await c.req.json()) as { text?: string };
  } catch {
    return c.json({ ok: false, error: 'invalid json' }, 400);
  }
  const text = (body.text ?? '').trim();
  if (!text) return c.json({ ok: false, error: 'empty message' }, 400);

  const meta = await getSession(sessionId);
  if (!meta) return c.json({ ok: false, error: 'session not found' }, 404);
  if (meta.userId !== auth.userId) {
    return c.json({ ok: false, error: 'not your session' }, 403);
  }

  try {
    await runAgent({ sessionId, userMessage: text });
    return c.json({ ok: true });
  } catch (e) {
    console.error('[modpilot] agent run failed', e);
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

chat.get('/:sessionId/events', async (c) => {
  const auth = await requireMod();
  if (!auth.ok) return c.json({ ok: false, error: auth.error }, 403);
  const sessionId = c.req.param('sessionId');
  const sinceParam = c.req.query('since');
  const since = Math.max(0, Number.parseInt(sinceParam ?? '0', 10) || 0);
  const meta = await getSession(sessionId);
  if (!meta) return c.json({ ok: false, error: 'session not found' }, 404);
  if (meta.userId !== auth.userId) {
    return c.json({ ok: false, error: 'not your session' }, 403);
  }
  const { events, nextCursor } = await getEvents(sessionId, since);
  const status = await getRunStatus(sessionId);
  return c.json({ ok: true, events, nextCursor, status, mode: meta.approvalMode });
});

chat.post('/:sessionId/stop', async (c) => {
  const auth = await requireMod();
  if (!auth.ok) return c.json({ ok: false, error: auth.error }, 403);
  const sessionId = c.req.param('sessionId');
  const meta = await getSession(sessionId);
  if (!meta) return c.json({ ok: false, error: 'session not found' }, 404);
  if (meta.userId !== auth.userId) return c.json({ ok: false, error: 'not your session' }, 403);

  const status = await getRunStatus(sessionId);
  // Raise the cooperative stop flag — a running loop sees it between turns.
  await setInterrupt(sessionId);

  // If the run is suspended on an approval, no loop is alive to observe the flag.
  // Tear it down directly so the UI unfreezes and the queued calls are dropped.
  if (status === 'awaiting_approval') {
    await clearPendingApproval(sessionId);
    await clearInterrupt(sessionId);
    await pushEvent(sessionId, { type: 'stopped', ts: Date.now() });
    await setRunStatus(sessionId, 'done');
  }
  return c.json({ ok: true });
});

chat.post('/:sessionId/mode', async (c) => {
  const auth = await requireMod();
  if (!auth.ok) return c.json({ ok: false, error: auth.error }, 403);
  const sessionId = c.req.param('sessionId');
  let body: { mode?: string };
  try {
    body = (await c.req.json()) as { mode?: string };
  } catch {
    return c.json({ ok: false, error: 'invalid json' }, 400);
  }
  if (body.mode !== 'auto' && body.mode !== 'manual') {
    return c.json({ ok: false, error: 'mode must be "auto" or "manual"' }, 400);
  }
  const meta = await getSession(sessionId);
  if (!meta) return c.json({ ok: false, error: 'session not found' }, 404);
  if (meta.userId !== auth.userId) return c.json({ ok: false, error: 'not your session' }, 403);

  await setApprovalMode(sessionId, body.mode);
  return c.json({ ok: true, mode: body.mode });
});

chat.post('/:sessionId/approve', async (c) => {
  const auth = await requireMod();
  if (!auth.ok) return c.json({ ok: false, error: auth.error }, 403);
  const sessionId = c.req.param('sessionId');
  let body: { callId?: string; decision?: string };
  try {
    body = (await c.req.json()) as { callId?: string; decision?: string };
  } catch {
    return c.json({ ok: false, error: 'invalid json' }, 400);
  }
  if (body.decision !== 'approve' && body.decision !== 'reject') {
    return c.json({ ok: false, error: 'decision must be "approve" or "reject"' }, 400);
  }

  const meta = await getSession(sessionId);
  if (!meta) return c.json({ ok: false, error: 'session not found' }, 404);
  if (meta.userId !== auth.userId) return c.json({ ok: false, error: 'not your session' }, 403);

  const pending = await getPendingApproval(sessionId);
  if (!pending) return c.json({ ok: false, error: 'no pending approval' }, 409);
  if (body.callId && body.callId !== pending.callId) {
    return c.json({ ok: false, error: 'stale approval — refresh' }, 409);
  }

  try {
    await resumeApproval({ sessionId, decision: body.decision });
    return c.json({ ok: true });
  } catch (e) {
    console.error('[modpilot] approval resume failed', e);
    return c.json({ ok: false, error: String(e) }, 500);
  }
});
