import { Hono } from 'hono';
import { redis } from '@devvit/web/server';
import { loadSettings, resweepRecent, retryFailedEmbeds } from '../core/repost';
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

// Maintenance sweep: retry failed embeds, then re-match recent unflagged posts
// against the full lookback window. Closes the realtime repost-detection race.
jobs.post('/resweep', async (c) => {
  try {
    const retry = await retryFailedEmbeds();
    const sweep = await resweepRecent();
    await redis.hSet('modpilot:repost:last-resweep', {
      ts: String(Date.now()),
      retried: String(retry.retried),
      pruned: String(retry.pruned),
      scanned: String(sweep.scanned),
      flagged: String(sweep.flagged),
    });
    console.log(
      `[modpilot:repost] resweep: retried ${retry.retried} (pruned ${retry.pruned}), scanned ${sweep.scanned}, flagged ${sweep.flagged}`
    );
  } catch (err) {
    console.error('[modpilot:repost] resweep job failed', err);
  }
  return c.json({ ok: true }, 200);
});
