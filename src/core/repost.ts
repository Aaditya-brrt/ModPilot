import { context, reddit, settings } from '@devvit/web/server';
import type { Post } from '@devvit/web/server';
import { isT3 } from '@devvit/shared-types/tid.js';
import { describeImage, embedText } from './gemini';
import { cosineSimilarity, similarityPercent } from './similarity';
import {
  clearEmbedRetry,
  deleteFingerprint,
  deleteFlag,
  getFingerprint,
  getFlag,
  isWhitelisted,
  listEmbedRetryIds,
  listFlagIds,
  listRecentFingerprintIds,
  markEmbedRetry,
  pruneEmbedRetryOlderThan,
  pruneOlderThan,
  saveFingerprint,
  saveFlag,
  setFlagStatus,
  type Fingerprint,
} from './fingerprint';

const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;

const IMAGE_EXT = /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i;
const REDDIT_IMAGE_HOST =
  /^https?:\/\/(i\.redd\.it|preview\.redd\.it|external-preview\.redd\.it|i\.imgur\.com)\//i;

export type FingerprintInputs = {
  postId: string;
  title: string;
  body: string;
  url: string;
  permalink: string;
  createdAtMs: number;
};

export type MatchResult = {
  originalPostId: string;
  textSim: number;
  imageSim: number;
  combined: number;
};

export type RepostSettings = {
  similarityThreshold: number;
  autoCommentEnabled: boolean;
  autoReportEnabled: boolean;
  lookbackDays: number;
};

function isLikelyImageUrl(url: string): boolean {
  if (!url) return false;
  if (REDDIT_IMAGE_HOST.test(url)) return true;
  return IMAGE_EXT.test(url);
}

// Text signal only — image content is embedded as its own vector so the two
// signals stay independent (a same-image repost with a fresh title still scores
// high on the image vector instead of being diluted into one blended vector).
function buildTextEmbedInput(title: string, body: string): string {
  const parts: string[] = [];
  if (title) parts.push(`Title: ${title}`);
  if (body) parts.push(`Body: ${body.slice(0, 1500)}`);
  return parts.join('\n');
}

export async function indexPost(
  input: FingerprintInputs
): Promise<Fingerprint | undefined> {
  let imageDescription = '';
  if (isLikelyImageUrl(input.url)) {
    try {
      imageDescription = await describeImage(input.url);
    } catch (err) {
      console.warn(`[modpilot:repost] image describe failed for ${input.postId}`, err);
    }
  }

  // Text vector is mandatory. If it fails, the post is invisible to detection —
  // queue for retry instead of silently dropping. The maintenance sweep
  // re-attempts these within the age cap.
  let embedding: Float32Array;
  try {
    embedding = await embedText(buildTextEmbedInput(input.title, input.body));
  } catch (err) {
    console.warn(
      `[modpilot:repost] text embed failed for ${input.postId} — queued for retry`,
      err
    );
    try {
      await markEmbedRetry(input.postId, input.createdAtMs);
    } catch {
      // best-effort; nothing else we can do
    }
    return undefined;
  }

  // Image vector is optional. Failure here is non-fatal: index the post
  // text-only rather than losing it. Text-only posts simply never get one.
  let imageEmbedding: Float32Array | undefined;
  if (imageDescription) {
    try {
      imageEmbedding = await embedText(imageDescription);
    } catch (err) {
      console.warn(
        `[modpilot:repost] image embed failed for ${input.postId} — indexing text-only`,
        err
      );
    }
  }

  const fp: Fingerprint = {
    postId: input.postId,
    title: input.title,
    permalink: input.permalink,
    embedding,
    ...(imageEmbedding ? { imageEmbedding } : {}),
    imageDescription,
    createdAt: input.createdAtMs,
  };
  await saveFingerprint(fp);
  console.log(
    `[modpilot:repost] indexed ${input.postId} — image vector ${imageEmbedding ? 'yes' : 'no'}`
  );
  // Indexed successfully — drop any prior retry entry for this post.
  try {
    await clearEmbedRetry(input.postId);
  } catch {
    // ignore
  }
  return fp;
}

// Devvit Redis has no multi-hash read (mGet is string-values only; fingerprints
// are hashes). The client is HTTP-backed, so concurrent calls parallelize —
// load candidates in bounded chunks instead of one blocking round-trip each.
// Turns N sequential RTTs into ceil(N / chunk). Bound concurrency so a 90-day
// window doesn't fire thousands of requests at once.
const FETCH_CHUNK = 50;

async function loadFingerprintsConcurrently(
  ids: string[]
): Promise<Fingerprint[]> {
  const out: Fingerprint[] = [];
  for (let i = 0; i < ids.length; i += FETCH_CHUNK) {
    const slice = ids.slice(i, i + FETCH_CHUNK);
    const fetched = await Promise.all(slice.map((id) => getFingerprint(id)));
    for (const candidate of fetched) {
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

export async function findBestMatch(
  fp: Fingerprint,
  opts: { lookbackDays: number; threshold: number; maxCreatedAt?: number }
): Promise<MatchResult | undefined> {
  const cutoff = fp.createdAt - opts.lookbackDays * 86_400_000;
  const candidateIds = await listRecentFingerprintIds(cutoff, fp.postId);
  const candidates = await loadFingerprintsConcurrently(candidateIds);

  let best: MatchResult | undefined;
  // Diagnostics: how many we actually scored (after the date filter) and the
  // single highest combined score seen — even below threshold, so logs reveal
  // "near misses" for tuning similarityThreshold.
  let compared = 0;
  let topScore = 0;
  for (const candidate of candidates) {
    // The "original" must predate the subject. Without this, a re-scan (where
    // both posts are already indexed) could flag the older original as a repost
    // of the newer copy. In the realtime path this is naturally true; enforcing
    // it makes the invariant hold for the maintenance sweep too.
    if (opts.maxCreatedAt !== undefined && candidate.createdAt >= opts.maxCreatedAt) continue;
    compared++;

    const textSim = similarityPercent(
      cosineSimilarity(fp.embedding, candidate.embedding)
    );

    // Real image similarity: compare image vectors only when BOTH posts have
    // one. Text-only posts (no image vector on either side) score imageSim = 0
    // and are decided purely on textSim.
    let imageSim = 0;
    if (fp.imageEmbedding && candidate.imageEmbedding) {
      imageSim = similarityPercent(
        cosineSimilarity(fp.imageEmbedding, candidate.imageEmbedding)
      );
    }

    // Flag on the strongest single signal. A copied image with a fresh title
    // (high imageSim, low textSim) and copied text on a new image (the reverse)
    // both surface now; the old blended vector buried both.
    const combined = Math.max(textSim, imageSim);
    if (combined > topScore) topScore = combined;
    if (combined < opts.threshold) continue;

    // Lazy whitelist: a per-candidate check was one Redis round-trip each. Only
    // check when a candidate would actually become the best — at most once per
    // improvement (~ln N expected), since "best" only advances through
    // non-whitelisted candidates and every candidate that could beat it is checked.
    if (!best || combined > best.combined) {
      if (await isWhitelisted(fp.postId, candidate.postId)) continue;
      best = {
        originalPostId: candidate.postId,
        textSim,
        imageSim,
        combined,
      };
    }
  }

  console.log(
    `[modpilot:repost] scan ${fp.postId}: ${compared}/${candidates.length} candidates, top ${topScore.toFixed(1)}%, ${
      best
        ? `match ${best.originalPostId} @ ${best.combined.toFixed(1)}%`
        : 'no match'
    }`
  );
  return best;
}

export async function loadSettings(): Promise<RepostSettings> {
  const [threshold, comment, report, lookback] = await Promise.all([
    settings.get<number>('similarityThreshold'),
    settings.get<boolean>('autoCommentEnabled'),
    settings.get<boolean>('autoReportEnabled'),
    settings.get<number>('lookbackDays'),
  ]);
  return {
    similarityThreshold: typeof threshold === 'number' ? threshold : 85,
    autoCommentEnabled: comment !== false,
    autoReportEnabled: report !== false,
    lookbackDays: typeof lookback === 'number' && lookback > 0 ? lookback : 90,
  };
}

function buildAutoCommentBody(match: MatchResult, originalLink: string): string {
  const pct = match.combined.toFixed(1);
  const detail =
    match.imageSim > 0
      ? ` (text ${match.textSim.toFixed(1)}%, image ${match.imageSim.toFixed(1)}%)`
      : '';
  const disclaimer = '> *Automated by ModPilot repost detection. A moderator will review.*';
  return [
    `**ModPilot** thinks this might be a repost (${pct}% similarity${detail}).`,
    '',
    `Possible original: ${originalLink}`,
    '',
    disclaimer,
  ].join('\n');
}

export async function processNewPost(
  post: Post
): Promise<MatchResult | undefined> {
  const cfg = await loadSettings();
  const fp = await indexPost({
    postId: post.id,
    title: post.title,
    body: post.body ?? '',
    url: post.url,
    permalink: post.permalink,
    createdAtMs: post.createdAt.getTime(),
  });
  if (!fp) return undefined;

  const match = await findBestMatch(fp, {
    lookbackDays: cfg.lookbackDays,
    threshold: cfg.similarityThreshold,
    maxCreatedAt: fp.createdAt,
  });

  if (!match) return undefined;

  await applyMatch(post, match, cfg);
  return match;
}

// Persist a flag and run the side-effects (auto-comment + report) for a confirmed
// match. Shared by the realtime path and the maintenance sweep so behavior stays
// identical regardless of which one catches the repost.
async function applyMatch(
  post: Post,
  match: MatchResult,
  cfg: RepostSettings
): Promise<void> {
  await saveFlag({
    postId: post.id,
    originalPostId: match.originalPostId,
    score: match.combined,
    textSim: match.textSim,
    imageSim: match.imageSim,
    status: 'open',
    createdAt: Date.now(),
  });

  const original = await getFingerprint(match.originalPostId);
  const originalLink = original
    ? `https://www.reddit.com${original.permalink}`
    : `https://www.reddit.com/comments/${match.originalPostId.replace(/^t3_/, '')}`;

  if (cfg.autoCommentEnabled) {
    try {
      await reddit.submitComment({
        id: post.id,
        text: buildAutoCommentBody(match, originalLink),
      });
    } catch (err) {
      console.warn(`[modpilot:repost] auto-comment failed for ${post.id}`, err);
    }
  }

  if (cfg.autoReportEnabled) {
    try {
      const reason =
        `ModPilot repost ${match.combined.toFixed(1)}% match with ${match.originalPostId}`.slice(
          0,
          100
        );
      await reddit.report(post, { reason });
    } catch (err) {
      console.warn(`[modpilot:repost] report failed for ${post.id}`, err);
    }
  }
}

// Maintenance sweep (#1): re-evaluate posts created in the last 24h that aren't
// yet flagged, matching each against the FULL lookback window. Catches reposts
// missed by the realtime race (two near-simultaneous posts whose embeds overlap,
// so neither saw the other in the index). Cheap: cosine over stored embeddings;
// fetches a post from Reddit only when a match is actually found.
export async function resweepRecent(): Promise<{ scanned: number; flagged: number }> {
  const cfg = await loadSettings();
  const since = Date.now() - SWEEP_WINDOW_MS;
  const ids = await listRecentFingerprintIds(since, '');

  let scanned = 0;
  let flagged = 0;
  for (const postId of ids) {
    if (!isT3(postId)) continue;
    if (await getFlag(postId)) continue; // already flagged — skip
    const fp = await getFingerprint(postId);
    if (!fp) continue;
    scanned++;

    const match = await findBestMatch(fp, {
      lookbackDays: cfg.lookbackDays,
      threshold: cfg.similarityThreshold,
      maxCreatedAt: fp.createdAt,
    });
    if (!match) continue;

    try {
      const post = await reddit.getPostById(postId);
      if (post.removed || post.spam) continue;
      await applyMatch(post, match, cfg);
      flagged++;
      console.log(
        `[modpilot:repost] resweep flagged ${postId} -> ${match.originalPostId} @ ${match.combined.toFixed(1)}% (text ${match.textSim.toFixed(1)}%, image ${match.imageSim.toFixed(1)}%)`
      );
    } catch (err) {
      console.warn(`[modpilot:repost] resweep flag failed for ${postId}`, err);
    }
  }
  return { scanned, flagged };
}

// Embed retry (#4): re-attempt posts whose embedding failed at index time, then
// prune anything older than the 24h cap (too stale to bother). indexPost clears a
// post from the retry set on success and re-queues it on repeated failure.
export async function retryFailedEmbeds(): Promise<{ retried: number; pruned: number }> {
  const since = Date.now() - SWEEP_WINDOW_MS;
  const pruned = await pruneEmbedRetryOlderThan(since);
  const ids = await listEmbedRetryIds(since);

  for (const postId of ids) {
    if (!isT3(postId)) {
      await clearEmbedRetry(postId);
      continue;
    }
    try {
      const post = await reddit.getPostById(postId);
      if (post.removed || post.spam) {
        await clearEmbedRetry(postId);
        continue;
      }
      await processNewPost(post); // re-embeds + indexes + flags; clears retry on success
    } catch (err) {
      console.warn(`[modpilot:repost] embed retry failed for ${postId}`, err);
    }
  }
  return { retried: ids.length, pruned };
}

export async function dropPost(postId: string): Promise<void> {
  await deleteFingerprint(postId);
}

// Prune flags (and their fingerprints) whose post no longer belongs to THIS
// subreddit: deleted posts, or leftover entries from earlier test installs in a
// different sub. These are un-actionable — remove_post fails with "only allowed
// inside the current subreddit", so the agent wastes turns trying to act on dead
// IDs and the modqueue surfaces ghosts. Bounded to the open-flag queue. Runs in
// the maintenance sweep and the manual cleanup.
export async function pruneStaleFlags(): Promise<{ checked: number; pruned: number }> {
  // The sub a mutation is allowed in is the INSTALLATION sub (context.subredditId)
  // — that's what post.remove() is scoped to and what the gRPC error reports. Use
  // it as the "foreign" baseline; getCurrentSubreddit() can resolve a different sub
  // in some contexts, which would let un-removable flags slip through. Fall back to
  // getCurrentSubreddit().id when context.subredditId is absent (e.g. scheduler).
  let ctxSubId: string | undefined;
  try {
    ctxSubId = context.subredditId;
  } catch {
    ctxSubId = undefined;
  }
  let getSubId = '';
  try {
    getSubId = (await reddit.getCurrentSubreddit()).id;
  } catch (err) {
    console.warn('[modpilot:repost] pruneStaleFlags: getCurrentSubreddit failed', err);
  }
  const currentSubId = ctxSubId || getSubId;
  if (!currentSubId) {
    console.warn('[modpilot:repost] pruneStaleFlags: cannot resolve current subreddit');
    return { checked: 0, pruned: 0 };
  }
  console.log(
    `[modpilot:repost] pruneStaleFlags: currentSubId=${currentSubId} (context.subredditId=${ctxSubId ?? 'n/a'}, getCurrentSubreddit=${getSubId || 'n/a'})`
  );

  const ids = await listFlagIds(500, true);
  let checked = 0;
  let pruned = 0;
  for (const postId of ids) {
    if (!isT3(postId)) {
      await deleteFlag(postId);
      pruned++;
      continue;
    }
    checked++;
    try {
      const post = await reddit.getPostById(postId);
      if (post.subredditId !== currentSubId) {
        // Foreign sub → un-removable here. (getPostById succeeds for any post; the
        // sub scope is only enforced on the mutation, so we check it ourselves.)
        await deleteFlag(postId);
        await deleteFingerprint(postId);
        pruned++;
        console.log(`[modpilot:repost] pruned stale flag ${postId} (not in current sub)`);
      } else if (post.removed) {
        // Already removed (by the agent, a mod, or out-of-band) → resolve so it
        // leaves the open flag queue instead of lingering as an open flag.
        await setFlagStatus(postId, 'confirmed', 'system');
        pruned++;
        console.log(`[modpilot:repost] resolved flag ${postId} (post already removed)`);
      }
    } catch {
      // Post gone / unfetchable → garbage, drop it entirely.
      await deleteFlag(postId);
      await deleteFingerprint(postId);
      pruned++;
      console.log(`[modpilot:repost] pruned stale flag ${postId} (post unfetchable)`);
    }
  }
  return { checked, pruned };
}

// Manual stale-data cleanup (the "Clean up repost data" menu action). PURE
// removal — never creates flags (unlike resweep/retry): reconcile open flags
// against live Reddit state (foreign/gone → delete, already-removed → resolve),
// then age-prune fingerprints and the embed-retry queue past the lookback window.
// Same operations the cron jobs do, exposed as one on-demand sweep.
export async function cleanupStaleData(): Promise<{
  flagsChecked: number;
  flagsPruned: number;
  fingerprintsPruned: number;
  retriesPruned: number;
}> {
  const cfg = await loadSettings();
  const stale = await pruneStaleFlags();
  const fingerprintsPruned = await pruneOlderThan(Date.now() - cfg.lookbackDays * 86_400_000);
  // Retry entries are only useful for ~24h; anything older is abandoned.
  const retriesPruned = await pruneEmbedRetryOlderThan(Date.now() - SWEEP_WINDOW_MS);
  console.log(
    `[modpilot:repost] cleanup: flags checked ${stale.checked} pruned ${stale.pruned}, ` +
      `fingerprints pruned ${fingerprintsPruned}, retries pruned ${retriesPruned}`
  );
  return {
    flagsChecked: stale.checked,
    flagsPruned: stale.pruned,
    fingerprintsPruned,
    retriesPruned,
  };
}

export async function backfillRecent(
  subredditName: string,
  limit: number
): Promise<{ indexed: number; failed: number }> {
  let indexed = 0;
  let failed = 0;
  const listing = reddit.getNewPosts({ subredditName, limit });
  for await (const post of listing) {
    if (post.removed || post.spam) continue;
    const existing = await getFingerprint(post.id);
    if (existing) continue;
    try {
      const fp = await indexPost({
        postId: post.id,
        title: post.title,
        body: post.body ?? '',
        url: post.url,
        permalink: post.permalink,
        createdAtMs: post.createdAt.getTime(),
      });
      if (fp) indexed += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[modpilot:repost] backfill failed for ${post.id}`, err);
    }
  }
  return { indexed, failed };
}
