import { redis } from '@devvit/web/server';
import { decodeEmbedding, encodeEmbedding } from './similarity';

export type Fingerprint = {
  postId: string;
  title: string;
  permalink: string;
  embedding: Float32Array;
  imageDescription: string;
  createdAt: number;
};

export type FlagStatus = 'open' | 'confirmed' | 'dismissed';

export type Flag = {
  postId: string;
  originalPostId: string;
  score: number;
  textSim: number;
  imageSim: number;
  status: FlagStatus;
  createdAt: number;
  reviewedBy?: string;
  reviewedAt?: number;
};

const FP_KEY = (postId: string) => `fp:${postId}`;
const FP_INDEX = 'fp:index';
const FLAG_KEY = (postId: string) => `flag:${postId}`;
const FLAG_QUEUE = 'flag:queue';
const WHITELIST_KEY = (a: string, b: string) => {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `whitelist:${lo}:${hi}`;
};

export async function saveFingerprint(fp: Fingerprint): Promise<void> {
  await redis.hSet(FP_KEY(fp.postId), {
    title: fp.title,
    permalink: fp.permalink,
    embedding: encodeEmbedding(fp.embedding),
    imageDescription: fp.imageDescription,
    createdAt: String(fp.createdAt),
  });
  await redis.zAdd(FP_INDEX, { member: fp.postId, score: fp.createdAt });
}

export async function getFingerprint(
  postId: string
): Promise<Fingerprint | undefined> {
  const h = await redis.hGetAll(FP_KEY(postId));
  if (!h || !h.embedding) return undefined;
  return {
    postId,
    title: h.title ?? '',
    permalink: h.permalink ?? '',
    embedding: decodeEmbedding(h.embedding),
    imageDescription: h.imageDescription ?? '',
    createdAt: Number(h.createdAt ?? 0),
  };
}

export async function deleteFingerprint(postId: string): Promise<void> {
  await redis.del(FP_KEY(postId));
  await redis.zRem(FP_INDEX, [postId]);
}

export async function listRecentFingerprintIds(
  sinceMs: number,
  excludeId: string
): Promise<string[]> {
  const ids = await redis.zRange(FP_INDEX, sinceMs, '+inf', {
    by: 'score',
  });
  return ids.map((entry) => entry.member).filter((id) => id !== excludeId);
}

export async function pruneOlderThan(cutoffMs: number): Promise<number> {
  const stale = await redis.zRange(FP_INDEX, '-inf', cutoffMs, {
    by: 'score',
  });
  if (stale.length === 0) return 0;
  const ids = stale.map((s) => s.member);
  for (const id of ids) {
    await redis.del(FP_KEY(id));
  }
  await redis.zRem(FP_INDEX, ids);
  return ids.length;
}

export async function saveFlag(flag: Flag): Promise<void> {
  await redis.hSet(FLAG_KEY(flag.postId), {
    originalPostId: flag.originalPostId,
    score: String(flag.score),
    textSim: String(flag.textSim),
    imageSim: String(flag.imageSim),
    status: flag.status,
    createdAt: String(flag.createdAt),
    ...(flag.reviewedBy ? { reviewedBy: flag.reviewedBy } : {}),
    ...(flag.reviewedAt ? { reviewedAt: String(flag.reviewedAt) } : {}),
  });
  if (flag.status === 'open') {
    await redis.zAdd(FLAG_QUEUE, { member: flag.postId, score: flag.createdAt });
  } else {
    await redis.zRem(FLAG_QUEUE, [flag.postId]);
  }
}

export async function getFlag(postId: string): Promise<Flag | undefined> {
  const h = await redis.hGetAll(FLAG_KEY(postId));
  if (!h || !h.originalPostId) return undefined;
  return {
    postId,
    originalPostId: h.originalPostId,
    score: Number(h.score ?? 0),
    textSim: Number(h.textSim ?? 0),
    imageSim: Number(h.imageSim ?? 0),
    status: (h.status as FlagStatus) ?? 'open',
    createdAt: Number(h.createdAt ?? 0),
    ...(h.reviewedBy ? { reviewedBy: h.reviewedBy } : {}),
    ...(h.reviewedAt ? { reviewedAt: Number(h.reviewedAt) } : {}),
  };
}

export async function listFlagIds(
  limit: number,
  openOnly: boolean
): Promise<string[]> {
  if (openOnly) {
    const entries = await redis.zRange(FLAG_QUEUE, 0, limit - 1, {
      by: 'rank',
      reverse: true,
    });
    return entries.map((e) => e.member);
  }
  return [];
}

export async function isWhitelisted(a: string, b: string): Promise<boolean> {
  const v = await redis.get(WHITELIST_KEY(a, b));
  return v === '1';
}

export async function whitelistPair(a: string, b: string): Promise<void> {
  await redis.set(WHITELIST_KEY(a, b), '1');
}

export async function setFlagStatus(
  postId: string,
  status: FlagStatus,
  reviewedBy: string
): Promise<void> {
  const flag = await getFlag(postId);
  if (!flag) return;
  await saveFlag({
    ...flag,
    status,
    reviewedBy,
    reviewedAt: Date.now(),
  });
}
