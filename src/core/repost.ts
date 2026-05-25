import { reddit, redis, settings } from '@devvit/web/server';
import type { Post } from '@devvit/web/server';
import { isT3 } from '@devvit/shared-types/tid.js';
import { describeImage, embedText } from './gemini';
import { cosineSimilarity, similarityPercent } from './similarity';
import {
  clearEmbedRetry,
  deleteFingerprint,
  getFingerprint,
  getFlag,
  isWhitelisted,
  listEmbedRetryIds,
  listRecentFingerprintIds,
  markEmbedRetry,
  pruneEmbedRetryOlderThan,
  saveFingerprint,
  saveFlag,
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

function buildEmbedText(
  title: string,
  body: string,
  imageDescription: string
): string {
  const parts: string[] = [];
  if (title) parts.push(`Title: ${title}`);
  if (body) parts.push(`Body: ${body.slice(0, 1500)}`);
  if (imageDescription) parts.push(`Image: ${imageDescription}`);
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

  const embedInput = buildEmbedText(input.title, input.body, imageDescription);
  let embedding: Float32Array;
  try {
    embedding = await embedText(embedInput);
  } catch (err) {
    // Queue for retry instead of silently dropping — an un-indexed post is
    // invisible to repost detection forever otherwise. The maintenance sweep
    // re-attempts these within the age cap.
    console.warn(
      `[modpilot:repost] embed failed for ${input.postId} — queued for retry`,
      err
    );
    try {
      await markEmbedRetry(input.postId, input.createdAtMs);
    } catch {
      // best-effort; nothing else we can do
    }
    return undefined;
  }

  const fp: Fingerprint = {
    postId: input.postId,
    title: input.title,
    permalink: input.permalink,
    embedding,
    imageDescription,
    createdAt: input.createdAtMs,
  };
  await saveFingerprint(fp);
  // Indexed successfully — drop any prior retry entry for this post.
  try {
    await clearEmbedRetry(input.postId);
  } catch {
    // ignore
  }
  return fp;
}

export async function findBestMatch(
  fp: Fingerprint,
  opts: { lookbackDays: number; threshold: number; maxCreatedAt?: number }
): Promise<MatchResult | undefined> {
  const cutoff = fp.createdAt - opts.lookbackDays * 86_400_000;
  const candidateIds = await listRecentFingerprintIds(cutoff, fp.postId);

  let best: MatchResult | undefined;
  for (const candidateId of candidateIds) {
    const candidate = await getFingerprint(candidateId);
    if (!candidate) continue;
    // The "original" must predate the subject. Without this, a re-scan (where
    // both posts are already indexed) could flag the older original as a repost
    // of the newer copy. In the realtime path this is naturally true; enforcing
    // it makes the invariant hold for the maintenance sweep too.
    if (opts.maxCreatedAt !== undefined && candidate.createdAt >= opts.maxCreatedAt) continue;
    if (await isWhitelisted(fp.postId, candidateId)) continue;

    const cosine = cosineSimilarity(fp.embedding, candidate.embedding);
    const combined = similarityPercent(cosine);
    if (combined < opts.threshold) continue;

    const imageSim =
      fp.imageDescription && candidate.imageDescription ? combined : 0;

    if (!best || combined > best.combined) {
      best = {
        originalPostId: candidateId,
        textSim: combined,
        imageSim,
        combined,
      };
    }
  }

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
  const imagePart =
    match.imageSim > 0 ? `, image similarity ${match.imageSim.toFixed(1)}%` : '';
  const disclaimer = '> *Automated by ModPilot repost detection. A moderator will review.*';
  return [
    `**ModPilot** thinks this might be a repost (${pct}% similarity${imagePart}).`,
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
        `[modpilot:repost] resweep flagged ${postId} -> ${match.originalPostId} @ ${match.combined.toFixed(1)}%`
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

export type DashboardFlag = {
  postId: string;
  originalPostId: string;
  score: number;
  textSim: number;
  imageSim: number;
  status: string;
  createdAt: number;
  subjectTitle: string;
  subjectPermalink: string;
  originalTitle: string;
  originalPermalink: string;
  imageDescription: string;
};

export async function exportFlagsForDashboard(
  limit: number
): Promise<DashboardFlag[]> {
  const ids = await redis.zRange('flag:queue', 0, limit - 1, {
    by: 'rank',
    reverse: true,
  });
  const rows: DashboardFlag[] = [];
  for (const entry of ids) {
    const postId = entry.member;
    const flagHash = await redis.hGetAll(`flag:${postId}`);
    if (!flagHash || !flagHash.originalPostId) continue;
    const originalFp = await getFingerprint(flagHash.originalPostId);
    const subjectFp = await getFingerprint(postId);
    rows.push({
      postId,
      originalPostId: flagHash.originalPostId,
      score: Number(flagHash.score ?? 0),
      textSim: Number(flagHash.textSim ?? 0),
      imageSim: Number(flagHash.imageSim ?? 0),
      status: flagHash.status ?? 'open',
      createdAt: Number(flagHash.createdAt ?? 0),
      subjectTitle: subjectFp?.title ?? '',
      subjectPermalink: subjectFp?.permalink ?? '',
      originalTitle: originalFp?.title ?? '',
      originalPermalink: originalFp?.permalink ?? '',
      imageDescription: subjectFp?.imageDescription ?? '',
    });
  }
  return rows;
}
