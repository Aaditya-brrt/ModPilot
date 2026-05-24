import { reddit, redis, settings } from '@devvit/web/server';
import type { Post } from '@devvit/web/server';
import { describeImage, embedText } from './gemini';
import { cosineSimilarity, similarityPercent } from './similarity';
import {
  deleteFingerprint,
  getFingerprint,
  isWhitelisted,
  listRecentFingerprintIds,
  saveFingerprint,
  saveFlag,
  type Fingerprint,
} from './fingerprint';

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
    console.warn(
      `[modpilot:repost] embed failed for ${input.postId} — skipping fingerprint`,
      err
    );
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
  return fp;
}

export async function findBestMatch(
  fp: Fingerprint,
  opts: { lookbackDays: number; threshold: number }
): Promise<MatchResult | undefined> {
  const cutoff = fp.createdAt - opts.lookbackDays * 86_400_000;
  const candidateIds = await listRecentFingerprintIds(cutoff, fp.postId);

  let best: MatchResult | undefined;
  for (const candidateId of candidateIds) {
    const candidate = await getFingerprint(candidateId);
    if (!candidate) continue;
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
  });

  if (!match) return undefined;

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

  return match;
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
