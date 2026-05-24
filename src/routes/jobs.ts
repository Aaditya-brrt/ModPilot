import { Hono } from 'hono';
import { redis } from '@devvit/web/server';
import { loadSettings } from '../core/repost';
import { pruneOlderThan } from '../core/fingerprint';

export const jobs = new Hono();

jobs.post('/cleanup', async (c) => {
  try {
    const cfg = await loadSettings();
    const cutoff = Date.now() - cfg.lookbackDays * 86_400_000;
    const removed = await pruneOlderThan(cutoff);
    await redis.hSet('modpilot:repost:last-cleanup', {
      ts: String(Date.now()),
      removed: String(removed),
      cutoff: String(cutoff),
    });
    console.log(`[modpilot:repost] cleanup: pruned ${removed} fingerprints`);
  } catch (err) {
    console.error('[modpilot:repost] cleanup job failed', err);
  }
  return c.json({ ok: true }, 200);
});
