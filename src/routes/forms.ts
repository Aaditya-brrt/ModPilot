import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context } from '@devvit/web/server';
import { isT1, isT3 } from '@devvit/shared-types/tid.js';
import { handleNuke, handleNukePost } from '../core/nuke';
import { cleanupStaleData } from '../core/repost';

type NukeFormValues = {
  remove?: boolean;
  lock?: boolean;
  skipDistinguished?: boolean;
  targetId?: string;
};

export const forms = new Hono();

const normalizeValues = (values: NukeFormValues) => ({
  remove: Boolean(values.remove),
  lock: Boolean(values.lock),
  skipDistinguished: Boolean(values.skipDistinguished),
});

const getTargetId = (values: NukeFormValues) => {
  if (typeof values.targetId === 'string' && values.targetId.trim()) {
    return values.targetId.trim();
  }
  return context.postId;
};

forms.post('/mop-comment-submit', async (c) => {
  const values = await c.req.json<NukeFormValues>();
  const normalized = normalizeValues(values);

  if (!normalized.lock && !normalized.remove) {
    return c.json<UiResponse>(
      { showToast: 'You must select either lock or remove.' },
      200
    );
  }

  const targetId = getTargetId(values);
  if (!isT1(targetId)) {
    return c.json<UiResponse>(
      { showToast: 'Mop failed: invalid comment id.' },
      200
    );
  }

  const result = await handleNuke({
    ...normalized,
    commentId: targetId,
    subredditId: context.subredditId,
  });

  return c.json<UiResponse>(
    {
      showToast: `${result.success ? 'Success' : 'Failed'} : ${result.message}`,
    },
    200
  );
});

forms.post('/clean-repost-data-submit', async (c) => {
  await c.req.json().catch(() => ({})); // no fields; just drain the body
  try {
    const r = await cleanupStaleData();
    return c.json<UiResponse>(
      {
        showToast:
          `Cleaned up: ${r.flagsPruned} stale flag(s) of ${r.flagsChecked} checked, ` +
          `${r.fingerprintsPruned} old fingerprint(s), ${r.retriesPruned} retry entr(ies).`,
      },
      200
    );
  } catch (err) {
    console.error('[modpilot:repost] clean-repost-data failed', err);
    return c.json<UiResponse>({ showToast: 'Cleanup failed. Check logs.' }, 200);
  }
});

forms.post('/mop-post-submit', async (c) => {
  const values = await c.req.json<NukeFormValues>();
  const normalized = normalizeValues(values);

  if (!normalized.lock && !normalized.remove) {
    return c.json<UiResponse>(
      { showToast: 'You must select either lock or remove.' },
      200
    );
  }

  const targetId = getTargetId(values);
  if (!isT3(targetId)) {
    return c.json<UiResponse>(
      { showToast: 'Mop failed: invalid post id.' },
      200
    );
  }

  const result = await handleNukePost({
    ...normalized,
    postId: targetId,
    subredditId: context.subredditId,
  });

  return c.json<UiResponse>(
    {
      showToast: `${result.success ? 'Success' : 'Failed'} : ${result.message}`,
    },
    200
  );
});

