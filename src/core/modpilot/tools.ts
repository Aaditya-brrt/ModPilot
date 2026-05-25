import { reddit } from '@devvit/web/server';
import type { Post, Comment } from '@devvit/web/server';
import { isT1, isT3 } from '@devvit/shared-types/tid.js';
import type { FunctionDeclaration } from './llm';
import { exportFlagsForDashboard, processNewPost } from '../repost';
import { getFingerprint, getFlag, setFlagStatus } from '../fingerprint';
import { describeImage } from '../gemini';

export type ToolCategory = 'read' | 'analyze' | 'mutate';

export type ToolResult = {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
};

export type ToolContext = {
  subreddit: string;
  actor: string;
};

export type ToolDef = {
  name: string;
  description: string;
  category: ToolCategory;
  parameters: FunctionDeclaration['parameters'];
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

// ---------- helpers ----------

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

// Full post detail — body, image description slot, report reasons. Heavy; only
// emit this for single-item fetches (get_post) where the agent needs everything.
function postSummary(p: Post) {
  return {
    id: p.id,
    title: p.title.slice(0, 200),
    author: p.authorName,
    score: p.score,
    numComments: p.numberOfComments,
    createdAt: p.createdAt.toISOString(),
    permalink: p.permalink,
    url: p.url,
    flair: p.flair?.text ?? '',
    removed: p.removed,
    locked: p.locked,
    stickied: p.stickied,
    body: (p.body ?? '').slice(0, 600),
    imageDescription: '' as string,
    numberOfReports: p.numberOfReports,
    userReportReasons: p.userReportReasons,
    modReportReasons: p.modReportReasons,
  };
}

// Compact post row for list/search results. Drops body, image description, url,
// and report-reason arrays — the bulk of the per-post token cost. The agent
// skims these to pick targets, then calls get_post for full detail on the few it
// actually acts on (progressive disclosure). numberOfReports is kept as a single
// number because it is cheap and drives triage.
function thinPostRow(p: Post) {
  return {
    id: p.id,
    title: p.title.slice(0, 200),
    author: p.authorName,
    score: p.score,
    numComments: p.numberOfComments,
    createdAt: p.createdAt.toISOString(),
    permalink: p.permalink,
    flair: p.flair?.text ?? '',
    removed: p.removed,
    locked: p.locked,
    stickied: p.stickied,
    numberOfReports: p.numberOfReports,
  };
}

// Attach Gemini-Vision descriptions (stored by repost detection at index time) to a
// batch of post summaries. Parallel Redis lookups — fast. Missing fingerprints
// silently leave imageDescription empty.
async function attachImageDescriptions<T extends { id: string; imageDescription: string }>(
  summaries: T[]
): Promise<T[]> {
  await Promise.all(
    summaries.map(async (s) => {
      try {
        const fp = await getFingerprint(s.id);
        if (fp?.imageDescription) s.imageDescription = fp.imageDescription;
      } catch {
        // ignore — empty stays
      }
    })
  );
  return summaries;
}

function commentSummary(c: Comment) {
  return {
    id: c.id,
    author: c.authorName,
    body: c.body.slice(0, 500),
    score: c.score,
    createdAt: c.createdAt.toISOString(),
    postId: c.postId,
    parentId: c.parentId,
    locked: c.locked,
  };
}

function err(msg: string): ToolResult {
  return { ok: false, summary: msg, error: msg };
}

function requireString(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ---------- READ TOOLS ----------

const search_posts: ToolDef = {
  name: 'search_posts',
  category: 'read',
  description:
    'List recent posts in the current subreddit, with optional substring filters on title/body/author/flair. ' +
    'Use this to find candidates before any mutation. Reddit has no true keyword search via Devvit, so this fetches recent posts and filters them server-side, returning only matches. ' +
    'Results are COMPACT rows (id, title, author, score, flair, counts, flags) — NOT the post body, image description, or report reasons. Call get_post on a specific id when you need full detail. ' +
    'Keep `limit` modest (scan depth, default 50, max 200). ' +
    'Example: search_posts({ sort: "new", limit: 100, query: "airdrop" }) returns compact rows for recent posts mentioning "airdrop".',
  parameters: {
    type: 'object',
    properties: {
      sort: {
        type: 'string',
        enum: ['new', 'hot'],
        description: 'Sort order. "new" = chronological, "hot" = currently popular. Default "new".',
      },
      limit: {
        type: 'number',
        description: 'How many posts to scan (max 200). Default 50.',
      },
      query: {
        type: 'string',
        description: 'Case-insensitive substring matched against title and body. Omit to return all.',
      },
      author: {
        type: 'string',
        description: 'Filter to a specific author username (no u/ prefix).',
      },
      flair: {
        type: 'string',
        description: 'Filter to posts with this flair text (case-insensitive substring).',
      },
      maxAgeHours: {
        type: 'number',
        description: 'Drop posts older than this many hours.',
      },
    },
  },
  execute: async (args, ctx) => {
    const sort = asString(args.sort, 'new') === 'hot' ? 'hot' : 'new';
    const limit = Math.min(200, Math.max(1, asNumber(args.limit, 50)));
    const query = requireString(args, 'query')?.toLowerCase();
    const author = requireString(args, 'author')?.toLowerCase();
    const flair = requireString(args, 'flair')?.toLowerCase();
    const maxAgeHours = asNumber(args.maxAgeHours, 0);
    const minCreated = maxAgeHours > 0 ? Date.now() - maxAgeHours * 3600_000 : 0;

    const listing =
      sort === 'hot'
        ? reddit.getHotPosts({ subredditName: ctx.subreddit, limit })
        : reddit.getNewPosts({ subredditName: ctx.subreddit, limit });

    const all = await listing.all();
    // Filter server-side; only matches are returned to the model.
    const filtered = all.filter((p) => {
      if (minCreated && p.createdAt.getTime() < minCreated) return false;
      if (author && p.authorName.toLowerCase() !== author) return false;
      if (flair) {
        const f = (p.flair?.text ?? '').toLowerCase();
        if (!f.includes(flair)) return false;
      }
      if (query) {
        const hay = `${p.title}\n${p.body ?? ''}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    const rows = filtered.slice(0, 50).map(thinPostRow);
    return {
      ok: true,
      summary: `Found ${filtered.length} matching post(s) (showing ${rows.length} compact rows — use get_post for full detail).`,
      data: { count: filtered.length, posts: rows },
    };
  },
};

const get_post: ToolDef = {
  name: 'get_post',
  category: 'read',
  description:
    'Fetch a single post by its t3_ id. Use before any mutation on a post to confirm what you are about to act on.',
  parameters: {
    type: 'object',
    required: ['postId'],
    properties: {
      postId: { type: 'string', description: 'Reddit post id, e.g. "t3_abc123".' },
    },
  },
  execute: async (args) => {
    const id = requireString(args, 'postId');
    if (!id || !isT3(id)) return err('postId must be a t3_... id');
    try {
      const p = await reddit.getPostById(id);
      const summary = postSummary(p);
      await attachImageDescriptions([summary]);
      return { ok: true, summary: `Post ${id} by u/${p.authorName}.`, data: summary };
    } catch (e) {
      return err(`Could not fetch post ${id}: ${String(e)}`);
    }
  },
};

const get_post_comments: ToolDef = {
  name: 'get_post_comments',
  category: 'read',
  description:
    'List comments on a post (default sort "top"). Use to inspect a discussion before locking, removing comments, or banning participants.',
  parameters: {
    type: 'object',
    required: ['postId'],
    properties: {
      postId: { type: 'string', description: 'Reddit post id, e.g. "t3_abc123".' },
      limit: { type: 'number', description: 'Max comments to return (max 50). Default 25.' },
    },
  },
  execute: async (args) => {
    const id = requireString(args, 'postId');
    if (!id || !isT3(id)) return err('postId must be a t3_... id');
    const limit = Math.min(50, Math.max(1, asNumber(args.limit, 25)));
    const listing = reddit.getComments({ postId: id, limit, sort: 'top' });
    const all = await listing.all();
    const trimmed = all.slice(0, limit).map(commentSummary);
    return {
      ok: true,
      summary: `Fetched ${trimmed.length} comments on ${id}.`,
      data: { count: all.length, comments: trimmed },
    };
  },
};

const get_user: ToolDef = {
  name: 'get_user',
  category: 'read',
  description:
    'Look up a Reddit user: karma totals, account age in days, NSFW flag. Use this to vet authors before bans (e.g. account age, low karma flag).',
  parameters: {
    type: 'object',
    required: ['username'],
    properties: {
      username: { type: 'string', description: 'Username without u/ prefix.' },
    },
  },
  execute: async (args) => {
    const username = requireString(args, 'username');
    if (!username) return err('username required');
    try {
      const u = await reddit.getUserByUsername(username);
      if (!u) return err(`User u/${username} not found.`);
      const ageDays = Math.round((Date.now() - u.createdAt.getTime()) / 86_400_000);
      const data = {
        username: u.username,
        id: u.id,
        ageDays,
        createdAt: u.createdAt.toISOString(),
        linkKarma: u.linkKarma,
        commentKarma: u.commentKarma,
        nsfw: u.nsfw,
      };
      return {
        ok: true,
        summary: `u/${u.username} — age ${ageDays}d, karma link ${u.linkKarma}/comment ${u.commentKarma}.`,
        data,
      };
    } catch (e) {
      return err(`Lookup failed: ${String(e)}`);
    }
  },
};

const get_user_posts: ToolDef = {
  name: 'get_user_posts',
  category: 'read',
  description: 'List recent posts by a user (any subreddit). Useful for vetting suspected spammers/karma farmers.',
  parameters: {
    type: 'object',
    required: ['username'],
    properties: {
      username: { type: 'string' },
      limit: { type: 'number', description: 'Max posts (max 50). Default 15.' },
    },
  },
  execute: async (args) => {
    const username = requireString(args, 'username');
    if (!username) return err('username required');
    const limit = Math.min(50, Math.max(1, asNumber(args.limit, 15)));
    const all = await reddit.getPostsByUser({ username, sort: 'new', limit }).all();
    const rows = all.slice(0, limit).map(thinPostRow);
    return { ok: true, summary: `Fetched ${rows.length} posts by u/${username}.`, data: rows };
  },
};

const get_user_comments: ToolDef = {
  name: 'get_user_comments',
  category: 'read',
  description: 'List recent comments by a user (any subreddit).',
  parameters: {
    type: 'object',
    required: ['username'],
    properties: {
      username: { type: 'string' },
      limit: { type: 'number', description: 'Max comments (max 50). Default 25.' },
    },
  },
  execute: async (args) => {
    const username = requireString(args, 'username');
    if (!username) return err('username required');
    const limit = Math.min(50, Math.max(1, asNumber(args.limit, 25)));
    const all = await reddit.getCommentsByUser({ username, sort: 'new', limit }).all();
    const trimmed = all.slice(0, limit).map(commentSummary);
    return { ok: true, summary: `Fetched ${trimmed.length} comments by u/${username}.`, data: trimmed };
  },
};

const get_modlog: ToolDef = {
  name: 'get_modlog',
  category: 'read',
  description:
    'Read the moderation log for the current subreddit. Filter by action type and/or moderator usernames. ' +
    'Use to audit a mod\'s actions, count removals over a window, or trace history of a single item.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max entries (max 100). Default 50.' },
      moderatorUsernames: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict to actions taken by these mods.',
      },
      actionType: {
        type: 'string',
        description: 'e.g. "removelink", "removecomment", "approvelink", "banuser", "lock", "spamlink".',
      },
    },
  },
  execute: async (args, ctx) => {
    const limit = Math.min(100, Math.max(1, asNumber(args.limit, 50)));
    const mods = Array.isArray(args.moderatorUsernames)
      ? (args.moderatorUsernames as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined;
    const actionType = requireString(args, 'actionType');
    const options: Record<string, unknown> = { subredditName: ctx.subreddit, limit };
    if (mods?.length) options.moderatorUsernames = mods;
    if (actionType) options.type = actionType;
    const all = await reddit
      .getModerationLog(options as Parameters<typeof reddit.getModerationLog>[0])
      .all();
    const trimmed = all.slice(0, limit).map((a) => ({
      id: a.id,
      type: a.type,
      mod: a.moderatorName,
      target: a.target?.id,
      targetAuthor: a.target?.author,
      targetPermalink: a.target?.permalink,
      details: a.details,
      description: a.description,
      createdAt: a.createdAt.toISOString(),
    }));
    return {
      ok: true,
      summary: `Fetched ${trimmed.length} modlog entries.`,
      data: trimmed,
    };
  },
};

const list_flagged_reposts: ToolDef = {
  name: 'list_flagged_reposts',
  category: 'read',
  description:
    'List posts the repost detector has flagged as suspected reposts. Each row includes score, suspected original, and current status (open/confirmed/dismissed).',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max flags (max 100). Default 25.' },
    },
  },
  execute: async (args) => {
    const limit = Math.min(100, Math.max(1, asNumber(args.limit, 25)));
    const rows = await exportFlagsForDashboard(limit);
    return {
      ok: true,
      summary: `Fetched ${rows.length} repost flag(s).`,
      data: rows,
    };
  },
};

const describe_image: ToolDef = {
  name: 'describe_image',
  category: 'analyze',
  description:
    'Run Gemini Vision on an image URL and return a 2-sentence description of distinctive subjects, composition, colors, and any visible text. ' +
    'Use when a post URL points to an image and you need to know what is actually IN it (e.g., to check rule violations involving visual content, identify meme templates, or verify image-based claims). ' +
    'Images larger than 200KB are skipped (returns empty) to stay within the per-app HTTP egress budget. ' +
    'Many already-indexed posts already include an `imageDescription` field in get_post / search_posts results — check there first before calling this on a known post.',
  parameters: {
    type: 'object',
    required: ['imageUrl'],
    properties: {
      imageUrl: {
        type: 'string',
        description: 'Direct image URL. Must be reachable (i.redd.it, preview.redd.it, imgur, etc.).',
      },
    },
  },
  execute: async (args) => {
    const url = requireString(args, 'imageUrl');
    if (!url) return err('imageUrl required');
    if (!/^https?:\/\//i.test(url)) return err('imageUrl must be http(s)');
    try {
      const desc = await describeImage(url);
      if (!desc) {
        return {
          ok: true,
          summary: 'Image skipped (over 200KB or vision returned empty).',
          data: { description: '', skipped: true },
        };
      }
      return {
        ok: true,
        summary: desc.length > 80 ? desc.slice(0, 77) + '…' : desc,
        data: { description: desc },
      };
    } catch (e) {
      return err(`describe_image failed: ${String(e)}`);
    }
  },
};

const check_post_for_repost: ToolDef = {
  name: 'check_post_for_repost',
  category: 'analyze',
  description:
    'Run repost detection against a single post on demand: fingerprint it (Gemini embedding + image vision) and find the nearest prior post above the configured similarity threshold. Returns the match or "no match".',
  parameters: {
    type: 'object',
    required: ['postId'],
    properties: {
      postId: { type: 'string' },
    },
  },
  execute: async (args) => {
    const id = requireString(args, 'postId');
    if (!id || !isT3(id)) return err('postId must be a t3_... id');
    try {
      const post = await reddit.getPostById(id);
      const match = await processNewPost(post);
      if (!match) {
        return { ok: true, summary: `No repost match for ${id}.`, data: { match: null } };
      }
      return {
        ok: true,
        summary: `Match: ${match.combined.toFixed(1)}% with ${match.originalPostId}.`,
        data: match,
      };
    } catch (e) {
      return err(`check_post_for_repost failed: ${String(e)}`);
    }
  },
};

// ---------- MUTATION TOOLS ----------
// All mutations require a `confirmation` field. The model must produce a sentence
// stating exactly what it intends to do, naming the target. This forces the model
// to have actually inspected the target before acting.

const CONFIRM_PROP = {
  type: 'string' as const,
  description:
    'A one-sentence statement describing exactly what this action will do and which item it targets, written for the moderator to read. Required — do not invent generic text; reference fields you actually fetched.',
};

const remove_post: ToolDef = {
  name: 'remove_post',
  category: 'mutate',
  description:
    'Remove a post from the subreddit. REQUIRES you to have called get_post (or search_posts which returned this id) on this same post first in this conversation. ' +
    'Use `isSpam: true` only when removing as spam (this also trains Reddit\'s spam filter against the author). Provide a short `reason` for the modlog.',
  parameters: {
    type: 'object',
    required: ['postId', 'confirmation'],
    properties: {
      postId: { type: 'string' },
      isSpam: { type: 'boolean', description: 'Default false. Use only for clear spam.' },
      reason: { type: 'string', description: 'Short reason (visible in modlog).' },
      confirmation: CONFIRM_PROP,
    },
  },
  execute: async (args, ctx) => {
    const id = requireString(args, 'postId');
    const confirmation = requireString(args, 'confirmation');
    if (!id || !isT3(id)) return err('postId must be t3_...');
    if (!confirmation || confirmation.length < 10) return err('confirmation required (>=10 chars)');
    const isSpam = asBool(args.isSpam, false);
    try {
      const post = await reddit.getPostById(id);
      await post.remove(isSpam);
      // If this post was a flagged repost, resolve the flag so it leaves the open
      // queue — otherwise list_flagged_reposts keeps surfacing it after removal.
      try {
        const flag = await getFlag(id);
        if (flag && flag.status === 'open') {
          await setFlagStatus(id, 'confirmed', ctx.actor);
        }
      } catch {
        // non-fatal — the removal already succeeded
      }
      return {
        ok: true,
        summary: `Removed ${id}${isSpam ? ' as spam' : ''}.`,
        data: { id, isSpam, confirmation },
      };
    } catch (e) {
      return err(`remove_post failed: ${String(e)}`);
    }
  },
};

const approve_post: ToolDef = {
  name: 'approve_post',
  category: 'mutate',
  description:
    'Approve a post (un-remove, mark as reviewed). REQUIRES prior get_post on the same id.',
  parameters: {
    type: 'object',
    required: ['postId', 'confirmation'],
    properties: {
      postId: { type: 'string' },
      confirmation: CONFIRM_PROP,
    },
  },
  execute: async (args, ctx) => {
    const id = requireString(args, 'postId');
    const confirmation = requireString(args, 'confirmation');
    if (!id || !isT3(id)) return err('postId must be t3_...');
    if (!confirmation) return err('confirmation required');
    try {
      const post = await reddit.getPostById(id);
      await post.approve();
      // Approving a flagged repost means the mod judged it NOT a repost — dismiss
      // the flag so it leaves the open queue (list_flagged_reposts).
      try {
        const flag = await getFlag(id);
        if (flag && flag.status === 'open') {
          await setFlagStatus(id, 'dismissed', ctx.actor);
        }
      } catch {
        // non-fatal — the approval already succeeded
      }
      return { ok: true, summary: `Approved ${id}.`, data: { id, confirmation } };
    } catch (e) {
      return err(`approve_post failed: ${String(e)}`);
    }
  },
};

const lock_post: ToolDef = {
  name: 'lock_post',
  category: 'mutate',
  description:
    'Lock a post so no new comments can be posted. REQUIRES prior get_post. Use to defuse a brigaded or heated thread.',
  parameters: {
    type: 'object',
    required: ['postId', 'confirmation'],
    properties: {
      postId: { type: 'string' },
      confirmation: CONFIRM_PROP,
    },
  },
  execute: async (args) => {
    const id = requireString(args, 'postId');
    const confirmation = requireString(args, 'confirmation');
    if (!id || !isT3(id)) return err('postId must be t3_...');
    if (!confirmation) return err('confirmation required');
    try {
      const post = await reddit.getPostById(id);
      await post.lock();
      return { ok: true, summary: `Locked ${id}.`, data: { id, confirmation } };
    } catch (e) {
      return err(`lock_post failed: ${String(e)}`);
    }
  },
};

const remove_comment: ToolDef = {
  name: 'remove_comment',
  category: 'mutate',
  description:
    'Remove a single comment by its t1_ id. REQUIRES you to have fetched this comment first (via get_post_comments or get_user_comments).',
  parameters: {
    type: 'object',
    required: ['commentId', 'confirmation'],
    properties: {
      commentId: { type: 'string' },
      isSpam: { type: 'boolean' },
      confirmation: CONFIRM_PROP,
    },
  },
  execute: async (args) => {
    const id = requireString(args, 'commentId');
    const confirmation = requireString(args, 'confirmation');
    if (!id || !isT1(id)) return err('commentId must be t1_...');
    if (!confirmation) return err('confirmation required');
    const isSpam = asBool(args.isSpam, false);
    try {
      const c = await reddit.getCommentById(id);
      await c.remove(isSpam);
      return { ok: true, summary: `Removed comment ${id}.`, data: { id, isSpam, confirmation } };
    } catch (e) {
      return err(`remove_comment failed: ${String(e)}`);
    }
  },
};

const ban_user: ToolDef = {
  name: 'ban_user',
  category: 'mutate',
  description:
    'Ban a user from the current subreddit. REQUIRES prior get_user on this username so you know account age + karma. ' +
    'Omit `duration` for a permanent ban; use a number of days (1-999) for a temp ban. ' +
    '`reason` is internal to mods; `message` is sent to the user.',
  parameters: {
    type: 'object',
    required: ['username', 'reason', 'confirmation'],
    properties: {
      username: { type: 'string' },
      duration: {
        type: 'number',
        description: 'Days. Omit for permanent. Range 1-999.',
      },
      reason: { type: 'string', description: 'Reason shown in modlog (max ~100 chars).' },
      message: { type: 'string', description: 'Optional message sent to the user.' },
      note: { type: 'string', description: 'Optional internal mod note.' },
      confirmation: CONFIRM_PROP,
    },
  },
  execute: async (args, ctx) => {
    const username = requireString(args, 'username');
    const reason = requireString(args, 'reason');
    const confirmation = requireString(args, 'confirmation');
    if (!username) return err('username required');
    if (!reason) return err('reason required');
    if (!confirmation) return err('confirmation required');
    const duration = asNumber(args.duration, 0);
    const message = requireString(args, 'message');
    const note = requireString(args, 'note');
    try {
      const banOpts: Record<string, unknown> = {
        username,
        subredditName: ctx.subreddit,
        reason: reason.slice(0, 100),
      };
      if (duration > 0) banOpts.duration = Math.min(999, Math.floor(duration));
      if (message) banOpts.message = message;
      if (note) banOpts.note = note;
      await reddit.banUser(banOpts as Parameters<typeof reddit.banUser>[0]);
      return {
        ok: true,
        summary: `Banned u/${username}${duration > 0 ? ` for ${duration}d` : ' permanently'}.`,
        data: { username, duration, reason, confirmation },
      };
    } catch (e) {
      return err(`ban_user failed: ${String(e)}`);
    }
  },
};

const reply_as_mod: ToolDef = {
  name: 'reply_as_mod',
  category: 'mutate',
  description:
    'Post a comment on the given post or as a reply to a comment. Optionally distinguish (mod badge) and sticky (top of thread). REQUIRES you to have fetched the target first.',
  parameters: {
    type: 'object',
    required: ['targetId', 'text', 'confirmation'],
    properties: {
      targetId: { type: 'string', description: 't3_ (post) or t1_ (comment) id to reply to.' },
      text: { type: 'string', description: 'Markdown body.' },
      distinguished: { type: 'boolean', description: 'Show mod badge. Default false.' },
      sticky: { type: 'boolean', description: 'Sticky to top of thread (post-level only). Default false.' },
      confirmation: CONFIRM_PROP,
    },
  },
  execute: async (args) => {
    const id = requireString(args, 'targetId');
    const text = requireString(args, 'text');
    const confirmation = requireString(args, 'confirmation');
    if (!id || (!isT1(id) && !isT3(id))) return err('targetId must be t1_ or t3_');
    if (!text) return err('text required');
    if (!confirmation) return err('confirmation required');
    const distinguished = asBool(args.distinguished, false);
    const sticky = asBool(args.sticky, false);
    try {
      const comment = await reddit.submitComment({ id: id as `t1_${string}` | `t3_${string}`, text });
      if (distinguished || sticky) {
        try {
          await comment.distinguish(sticky);
        } catch {
          // distinguish may fail if no mod permission; ignore non-fatally
        }
      }
      return {
        ok: true,
        summary: `Posted reply ${comment.id} on ${id}.`,
        data: { commentId: comment.id, targetId: id, confirmation },
      };
    } catch (e) {
      return err(`reply_as_mod failed: ${String(e)}`);
    }
  },
};

// ---------- TIER S + MOD NOTES (verified Devvit APIs) ----------

const get_subreddit_rules: ToolDef = {
  name: 'get_subreddit_rules',
  category: 'read',
  description:
    'Return the rule list for the current subreddit (shortName, description, kind, priority). ' +
    'Call this BEFORE reasoning about whether content violates "rule N" — you cannot judge violations without the actual rule text.',
  parameters: { type: 'object', properties: {} },
  execute: async (_args, ctx) => {
    try {
      const rules = await reddit.getRules(ctx.subreddit);
      const rows = rules.map((r) => ({
        priority: r.priority,
        shortName: r.shortName,
        description: r.description.slice(0, 800),
        kind: r.kind,
        violationReason: r.violationReason,
      }));
      return {
        ok: true,
        summary: `Fetched ${rows.length} rule(s) for r/${ctx.subreddit}.`,
        data: rows,
      };
    } catch (e) {
      return err(`get_subreddit_rules failed: ${String(e)}`);
    }
  },
};

const get_modqueue: ToolDef = {
  name: 'get_modqueue',
  category: 'read',
  description:
    'List items currently in the modqueue (posts/comments needing review). Optionally filter by type. ' +
    'This is where most mod triage starts — call before deciding what to act on.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['all', 'post', 'comment'],
        description: 'Default "all".',
      },
      limit: { type: 'number', description: 'Max items (max 100). Default 25.' },
    },
  },
  execute: async (args, ctx) => {
    const t = args.type;
    const type: 'all' | 'post' | 'comment' = t === 'post' ? 'post' : t === 'comment' ? 'comment' : 'all';
    const limit = Math.min(100, Math.max(1, asNumber(args.limit, 25)));
    try {
      const sub = await reddit.getSubredditByName(ctx.subreddit);
      const listing =
        type === 'post'
          ? sub.getModQueue({ type: 'post', limit })
          : type === 'comment'
            ? sub.getModQueue({ type: 'comment', limit })
            : sub.getModQueue({ type: 'all', limit });
      const items = await listing.all();
      const trimmed: Array<Record<string, unknown>> = [];
      for (const it of items.slice(0, limit)) {
        if ('title' in it) {
          trimmed.push({ kind: 'post', ...postSummary(it) });
        } else {
          trimmed.push({ kind: 'comment', ...commentSummary(it) });
        }
      }
      const postRows = trimmed.filter(
        (t) => t.kind === 'post'
      ) as Array<{ id: string; imageDescription: string }>;
      if (postRows.length) await attachImageDescriptions(postRows);
      return {
        ok: true,
        summary: `${items.length} item(s) in modqueue (showing ${trimmed.length}).`,
        data: trimmed,
      };
    } catch (e) {
      return err(`get_modqueue failed: ${String(e)}`);
    }
  },
};

const get_modmail: ToolDef = {
  name: 'get_modmail',
  category: 'read',
  description:
    'List recent modmail conversations for the current subreddit. Returns conversation IDs + subjects + last-updated + participant. ' +
    'Drill into a single thread via get_modmail_thread before replying.',
  parameters: {
    type: 'object',
    properties: {
      state: {
        type: 'string',
        enum: [
          'all',
          'new',
          'inprogress',
          'archived',
          'appeals',
          'join_requests',
          'highlighted',
          'mod',
          'notifications',
          'inbox',
          'filtered',
          'default',
        ],
        description: 'Default "all".',
      },
      sort: {
        type: 'string',
        enum: ['recent', 'mod', 'user', 'unread'],
        description: 'Default "recent".',
      },
      limit: { type: 'number', description: 'Max conversations (1-100). Default 25.' },
    },
  },
  execute: async (args, ctx) => {
    const limit = Math.min(100, Math.max(1, asNumber(args.limit, 25)));
    const state = (typeof args.state === 'string' ? args.state : 'all') as
      | 'all'
      | 'new'
      | 'inprogress'
      | 'archived'
      | 'appeals'
      | 'join_requests'
      | 'highlighted'
      | 'mod'
      | 'notifications'
      | 'inbox'
      | 'filtered'
      | 'default';
    const sort = (typeof args.sort === 'string' ? args.sort : 'recent') as
      | 'recent'
      | 'mod'
      | 'user'
      | 'unread';
    try {
      const res = await reddit.modMail.getConversations({
        subreddits: [ctx.subreddit],
        limit,
        state,
        sort,
      });
      const out = (res.conversationIds || []).map((id) => {
        const c = res.conversations[id];
        if (!c) return { id };
        return {
          id: c.id,
          subject: c.subject,
          state: c.state,
          isInternal: c.isInternal,
          numMessages: c.numMessages,
          lastUpdated: c.lastUpdated,
          lastUnread: c.lastUnread,
          participant: c.participant?.name,
        };
      });
      return {
        ok: true,
        summary: `Fetched ${out.length} modmail conversation(s).`,
        data: out,
      };
    } catch (e) {
      return err(`get_modmail failed: ${String(e)}`);
    }
  },
};

const get_modmail_thread: ToolDef = {
  name: 'get_modmail_thread',
  category: 'read',
  description:
    'Read all messages in a single modmail conversation. REQUIRED before reply_modmail so you have actual context to respond to.',
  parameters: {
    type: 'object',
    required: ['conversationId'],
    properties: {
      conversationId: { type: 'string' },
      markRead: {
        type: 'boolean',
        description: 'Mark conversation read while fetching. Default false.',
      },
    },
  },
  execute: async (args) => {
    const id = requireString(args, 'conversationId');
    if (!id) return err('conversationId required');
    const markRead = asBool(args.markRead, false);
    try {
      const res = await reddit.modMail.getConversation({ conversationId: id, markRead });
      const conv = res.conversation;
      const messages = Object.values(conv?.messages ?? {}).map((m) => ({
        id: m.id,
        author: m.author?.name,
        body: (m.bodyMarkdown ?? m.body ?? '').slice(0, 1500),
        date: m.date,
        isInternal: m.isInternal,
      }));
      return {
        ok: true,
        summary: `Fetched conversation ${id} (${messages.length} message(s)).`,
        data: {
          id: conv?.id,
          subject: conv?.subject,
          state: conv?.state,
          participant: conv?.participant?.name,
          numMessages: conv?.numMessages,
          messages,
        },
      };
    } catch (e) {
      return err(`get_modmail_thread failed: ${String(e)}`);
    }
  },
};

const get_mod_notes: ToolDef = {
  name: 'get_mod_notes',
  category: 'read',
  description:
    'List mod notes saved against a user in this subreddit (notes, bans, mutes, warnings, etc.). ' +
    'Read this BEFORE acting on a repeat offender — past context often matters.',
  parameters: {
    type: 'object',
    required: ['username'],
    properties: {
      username: { type: 'string' },
      filter: {
        type: 'string',
        enum: [
          'NOTE',
          'APPROVAL',
          'REMOVAL',
          'BAN',
          'MUTE',
          'INVITE',
          'SPAM',
          'CONTENT_CHANGE',
          'MOD_ACTION',
          'ALL',
        ],
        description: 'Default ALL.',
      },
      limit: { type: 'number', description: 'Max notes (max 100). Default 25.' },
    },
  },
  execute: async (args, ctx) => {
    const username = requireString(args, 'username');
    if (!username) return err('username required');
    const limit = Math.min(100, Math.max(1, asNumber(args.limit, 25)));
    const filter = (typeof args.filter === 'string' ? args.filter : 'ALL') as
      | 'NOTE'
      | 'APPROVAL'
      | 'REMOVAL'
      | 'BAN'
      | 'MUTE'
      | 'INVITE'
      | 'SPAM'
      | 'CONTENT_CHANGE'
      | 'MOD_ACTION'
      | 'ALL';
    try {
      const all = await reddit
        .getModNotes({ subreddit: ctx.subreddit, user: username, filter, limit })
        .all();
      const trimmed = all.slice(0, limit).map((n) => ({
        id: n.id,
        type: n.type,
        operator: n.operator?.name,
        createdAt: n.createdAt.toISOString(),
        note: n.userNote?.note,
        label: n.userNote?.label,
      }));
      return {
        ok: true,
        summary: `Fetched ${trimmed.length} mod note(s) on u/${username}.`,
        data: trimmed,
      };
    } catch (e) {
      return err(`get_mod_notes failed: ${String(e)}`);
    }
  },
};

const unban_user: ToolDef = {
  name: 'unban_user',
  category: 'mutate',
  description:
    'Lift a ban on a user in the current subreddit. REQUIRES prior get_user OR get_mod_notes call on the same username — you should know why they were banned before lifting it.',
  parameters: {
    type: 'object',
    required: ['username', 'confirmation'],
    properties: {
      username: { type: 'string' },
      confirmation: CONFIRM_PROP,
    },
  },
  execute: async (args, ctx) => {
    const username = requireString(args, 'username');
    const confirmation = requireString(args, 'confirmation');
    if (!username) return err('username required');
    if (!confirmation) return err('confirmation required');
    try {
      await reddit.unbanUser(username, ctx.subreddit);
      return {
        ok: true,
        summary: `Unbanned u/${username} from r/${ctx.subreddit}.`,
        data: { username, confirmation },
      };
    } catch (e) {
      return err(`unban_user failed: ${String(e)}`);
    }
  },
};

const approve_comment: ToolDef = {
  name: 'approve_comment',
  category: 'mutate',
  description:
    'Approve a comment (un-remove, mark reviewed). REQUIRES prior fetch via get_post_comments or get_user_comments.',
  parameters: {
    type: 'object',
    required: ['commentId', 'confirmation'],
    properties: {
      commentId: { type: 'string' },
      confirmation: CONFIRM_PROP,
    },
  },
  execute: async (args) => {
    const id = requireString(args, 'commentId');
    const confirmation = requireString(args, 'confirmation');
    if (!id || !isT1(id)) return err('commentId must be t1_...');
    if (!confirmation) return err('confirmation required');
    try {
      const c = await reddit.getCommentById(id);
      await c.approve();
      return { ok: true, summary: `Approved comment ${id}.`, data: { id, confirmation } };
    } catch (e) {
      return err(`approve_comment failed: ${String(e)}`);
    }
  },
};

const add_mod_note: ToolDef = {
  name: 'add_mod_note',
  category: 'mutate',
  description:
    'Add a mod note on a user in this subreddit. Visible to other mods only. Use to record context for future decisions (warnings, appeal outcomes, repeat-offender markers). REQUIRES prior get_user. Max 250 chars.',
  parameters: {
    type: 'object',
    required: ['username', 'note', 'confirmation'],
    properties: {
      username: { type: 'string' },
      note: { type: 'string', description: 'Max 250 chars. Plain text.' },
      label: {
        type: 'string',
        enum: [
          'BOT_BAN',
          'PERMA_BAN',
          'BAN',
          'ABUSE_WARNING',
          'SPAM_WARNING',
          'SPAM_WATCH',
          'SOLID_CONTRIBUTOR',
          'HELPFUL_USER',
        ],
        description: 'Optional label classifying the note.',
      },
      redditId: {
        type: 'string',
        description: 'Optional t1_/t3_ id to anchor the note to a specific comment/post.',
      },
      confirmation: CONFIRM_PROP,
    },
  },
  execute: async (args, ctx) => {
    const username = requireString(args, 'username');
    const note = requireString(args, 'note');
    const confirmation = requireString(args, 'confirmation');
    if (!username) return err('username required');
    if (!note) return err('note required');
    if (!confirmation) return err('confirmation required');
    const label = typeof args.label === 'string' ? args.label : undefined;
    const redditIdArg = requireString(args, 'redditId');
    const redditId =
      redditIdArg && (isT1(redditIdArg) || isT3(redditIdArg)) ? redditIdArg : undefined;
    try {
      const opts: Parameters<typeof reddit.addModNote>[0] = {
        subreddit: ctx.subreddit,
        user: username,
        note: note.slice(0, 250),
      } as Parameters<typeof reddit.addModNote>[0];
      if (label) (opts as Record<string, unknown>).label = label;
      if (redditId) (opts as Record<string, unknown>).redditId = redditId;
      const result = await reddit.addModNote(opts);
      return {
        ok: true,
        summary: `Added mod note on u/${username}.`,
        data: { username, noteId: result.id, confirmation },
      };
    } catch (e) {
      return err(`add_mod_note failed: ${String(e)}`);
    }
  },
};

const reply_modmail: ToolDef = {
  name: 'reply_modmail',
  category: 'mutate',
  description:
    'Reply in an existing modmail conversation. REQUIRES prior get_modmail_thread on the same conversationId. ' +
    'Set isInternal: true for a mod-only note (not visible to the user).',
  parameters: {
    type: 'object',
    required: ['conversationId', 'body', 'confirmation'],
    properties: {
      conversationId: { type: 'string' },
      body: { type: 'string', description: 'Markdown reply body.' },
      isInternal: {
        type: 'boolean',
        description: 'Mod-only internal note. Default false.',
      },
      isAuthorHidden: {
        type: 'boolean',
        description: 'Hide your username (post as the subreddit). Default false.',
      },
      confirmation: CONFIRM_PROP,
    },
  },
  execute: async (args) => {
    const conversationId = requireString(args, 'conversationId');
    const body = requireString(args, 'body');
    const confirmation = requireString(args, 'confirmation');
    if (!conversationId) return err('conversationId required');
    if (!body) return err('body required');
    if (!confirmation) return err('confirmation required');
    const isInternal = asBool(args.isInternal, false);
    const isAuthorHidden = asBool(args.isAuthorHidden, false);
    try {
      await reddit.modMail.reply({ conversationId, body, isInternal, isAuthorHidden });
      return {
        ok: true,
        summary: `Replied in modmail ${conversationId}.`,
        data: { conversationId, isInternal, confirmation },
      };
    } catch (e) {
      return err(`reply_modmail failed: ${String(e)}`);
    }
  },
};

const send_modmail: ToolDef = {
  name: 'send_modmail',
  category: 'mutate',
  description:
    'Start a new modmail conversation in this subreddit. `to` can be "u/username" (DM user), "r/sub" (cross-sub), or omitted (internal mod discussion). ' +
    'Prefer reply_modmail for existing threads.',
  parameters: {
    type: 'object',
    required: ['subject', 'body', 'confirmation'],
    properties: {
      subject: { type: 'string', description: 'Max 100 chars.' },
      body: { type: 'string', description: 'Markdown body.' },
      to: {
        type: 'string',
        description:
          'Optional. "u/username" for user DM, "r/sub" for cross-sub. Omit for internal mod discussion.',
      },
      isAuthorHidden: {
        type: 'boolean',
        description: 'Hide your username (post as the subreddit). Default false.',
      },
      confirmation: CONFIRM_PROP,
    },
  },
  execute: async (args, ctx) => {
    const subject = requireString(args, 'subject');
    const body = requireString(args, 'body');
    const confirmation = requireString(args, 'confirmation');
    if (!subject) return err('subject required');
    if (!body) return err('body required');
    if (!confirmation) return err('confirmation required');
    const to = requireString(args, 'to');
    const isAuthorHidden = asBool(args.isAuthorHidden, false);
    try {
      const params: {
        body: string;
        subredditName: string;
        subject: string;
        isAuthorHidden?: boolean;
        to?: string | null;
      } = {
        body,
        subredditName: ctx.subreddit,
        subject: subject.slice(0, 100),
        isAuthorHidden,
      };
      if (to) params.to = to;
      const res = await reddit.modMail.createConversation(params);
      return {
        ok: true,
        summary: `Sent modmail "${subject.slice(0, 50)}".`,
        data: { conversationId: res.conversation?.id, confirmation },
      };
    } catch (e) {
      return err(`send_modmail failed: ${String(e)}`);
    }
  },
};

// ---------- REGISTRY ----------

export const TOOL_REGISTRY: Record<string, ToolDef> = {
  search_posts,
  get_post,
  get_post_comments,
  get_user,
  get_user_posts,
  get_user_comments,
  get_modlog,
  list_flagged_reposts,
  check_post_for_repost,
  describe_image,
  get_subreddit_rules,
  get_modqueue,
  get_modmail,
  get_modmail_thread,
  get_mod_notes,
  remove_post,
  approve_post,
  lock_post,
  remove_comment,
  approve_comment,
  ban_user,
  unban_user,
  add_mod_note,
  reply_modmail,
  send_modmail,
  reply_as_mod,
};

export function getFunctionDeclarations(): FunctionDeclaration[] {
  return Object.values(TOOL_REGISTRY).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const tool = TOOL_REGISTRY[name];
  if (!tool) {
    return { ok: false, summary: `Unknown tool: ${name}`, error: 'unknown_tool' };
  }
  try {
    return await tool.execute(args, ctx);
  } catch (e) {
    return { ok: false, summary: `Tool threw: ${String(e)}`, error: String(e) };
  }
}

export function getToolCategory(name: string): ToolCategory | undefined {
  return TOOL_REGISTRY[name]?.category;
}
