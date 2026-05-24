import { Hono } from 'hono';
import type {
  OnAppInstallRequest,
  OnPostCreateRequest,
  OnPostDeleteRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import { reddit } from '@devvit/web/server';
import { isT3 } from '@devvit/shared-types/tid.js';
import { dropPost, processNewPost } from '../core/repost';

export const triggers = new Hono();

const ok = (c: { json: (body: TriggerResponse, status: number) => Response }) =>
  c.json({} as TriggerResponse, 200);

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  console.log('[modpilot] installed on r/' + input.subreddit?.name);
  return ok(c);
});

triggers.post('/on-post-create', async (c) => {
  const input = await c.req.json<OnPostCreateRequest>();
  const postId = input.post?.id;
  if (!postId || !isT3(postId)) {
    console.warn('[modpilot:repost] PostCreate without t3 id');
    return ok(c);
  }

  try {
    const post = await reddit.getPostById(postId);
    if (post.removed || post.spam) return ok(c);
    const match = await processNewPost(post);
    if (match) {
      console.log(
        `[modpilot:repost] flagged ${postId} -> ${match.originalPostId} @ ${match.combined.toFixed(1)}%`
      );
    }
  } catch (err) {
    console.error(`[modpilot:repost] PostCreate handler failed for ${postId}`, err);
  }
  return ok(c);
});

triggers.post('/on-post-delete', async (c) => {
  const input = await c.req.json<OnPostDeleteRequest>();
  const postId = input.postId;
  if (postId && isT3(postId)) {
    try {
      await dropPost(postId);
    } catch (err) {
      console.warn(`[modpilot:repost] dropPost failed for ${postId}`, err);
    }
  }
  return ok(c);
});
