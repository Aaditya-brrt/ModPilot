import { context, reddit } from '@devvit/web/server';
import type { Post, Comment } from '@devvit/web/server';
import { isT1, isT3 } from '@devvit/shared-types/tid.js';
import type { FunctionDeclaration } from './llm';
import { processNewPost } from '../repost';
import { getFingerprint, getFlag, setFlagStatus } from '../fingerprint';
import { classifyPostsAgainstRules, describeImage } from '../gemini';
import type { RuleVerdict } from '../gemini';
import { validateAutomodConfig } from '../automod/validate';

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

// Mutations are scoped by the Devvit runtime to the INSTALLATION's subreddit
// (context.subredditId). A target in another sub — typically surfaced by a
// cross-sub read like get_user_posts/get_user_comments, which return a user's
// activity site-wide — fails with a cryptic gRPC error ("only allowed inside the
// current subreddit: t5_..."). Catch it up front with a clear message so the
// agent skips the doomed call instead of looking like the data is corrupt.
// Returns an error string when foreign, or null when same-sub (or unknown).
function foreignSubError(itemSubId: string): string | null {
  const current = context.subredditId;
  if (current && itemSubId && itemSubId !== current) {
    return (
      `Target is in subreddit ${itemSubId}, not the current one (${current}). ` +
      'Moderation actions only work inside this community — this item belongs to a ' +
      'different subreddit (likely surfaced by a cross-sub user-history read) and cannot be actioned here.'
    );
  }
  return null;
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

// Bare hostname of a post's url (external domain for link posts, reddit.com for
// self-posts) — a cheap signal for link/self-promo rules, fed to the classifier.
function urlDomain(u: string | undefined): string {
  if (!u) return '';
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
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

const scan_rule_violations: ToolDef = {
  name: 'scan_rule_violations',
  category: 'analyze',
  description:
    'Scan recent posts (or the modqueue) for subreddit-rule violations using the actual rule text. ' +
    'Fetches the rules, then judges each post against ALL of them in batched model calls and returns only ' +
    'clear violations (cited rule shortName + confidence + a short reason quoting the trigger). ' +
    'Use this whenever the moderator asks to find, check, or flag rule-breaking posts — it is far cheaper than ' +
    'fetching every post and judging them one by one. It does NOT remove or report anything: review the ' +
    'returned violations, then call remove_post / reply_as_mod (or report) on the ones you and the moderator agree on.',
  parameters: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        enum: ['recent', 'modqueue'],
        description: 'Where to pull posts from. "recent" = newest posts; "modqueue" = items awaiting review. Default "recent".',
      },
      limit: { type: 'number', description: 'Max posts to scan (max 50). Default 25.' },
      maxAgeHours: {
        type: 'number',
        description:
          'Optional: only scan posts created within this many hours (e.g. 72 = last 3 days). ' +
          'Applies to source="recent". Default: scan the newest posts regardless of age.',
      },
      rule: {
        type: 'string',
        description: 'Optional: focus on a single rule by (substring of) its shortName. Default: check against all rules.',
      },
      minConfidence: {
        type: 'number',
        description: 'Only return violations at/above this confidence (0-100). Default 70.',
      },
    },
  },
  execute: async (args, ctx) => {
    const source = args.source === 'modqueue' ? 'modqueue' : 'recent';
    const limit = Math.min(50, Math.max(1, asNumber(args.limit, 25)));
    const maxAgeHours = Math.max(0, asNumber(args.maxAgeHours, 0)); // 0 = no age filter
    const minConfidence = Math.min(100, Math.max(0, asNumber(args.minConfidence, 70)));
    const ruleFilter = requireString(args, 'rule');
    try {
      let rules = await reddit.getRules(ctx.subreddit);
      if (ruleFilter) {
        const f = ruleFilter.toLowerCase();
        rules = rules.filter((r) => r.shortName.toLowerCase().includes(f));
        if (rules.length === 0) {
          return err(`No rule matching "${ruleFilter}". Call get_subreddit_rules to see exact names.`);
        }
      }
      if (rules.length === 0) {
        return { ok: true, summary: 'No rules configured for this subreddit.', data: { scanned: 0, violations: [] } };
      }

      // Gather candidate posts.
      let posts: Post[];
      if (source === 'modqueue') {
        const sub = await reddit.getSubredditByName(ctx.subreddit);
        const items = await sub.getModQueue({ type: 'post', limit }).all();
        posts = items.filter((it): it is Post => 'title' in it).slice(0, limit);
      } else {
        // With an age window, fetch a wider page (up to 50) then filter by age, so
        // a "last 3 days" scan isn't capped to the newest `limit` posts.
        const fetchN = maxAgeHours > 0 ? 50 : limit;
        const all = await reddit.getNewPosts({ subredditName: ctx.subreddit, limit: fetchN }).all();
        let live = all.filter((p) => !p.removed && !p.spam);
        if (maxAgeHours > 0) {
          const cutoff = Date.now() - maxAgeHours * 3_600_000;
          live = live.filter((p) => p.createdAt.getTime() >= cutoff);
        }
        posts = live.slice(0, maxAgeHours > 0 ? 50 : limit);
      }
      if (posts.length === 0) {
        return {
          ok: true,
          summary:
            maxAgeHours > 0
              ? `No posts in the last ${maxAgeHours}h to scan.`
              : `No ${source} posts to scan.`,
          data: { scanned: 0, violations: [] },
        };
      }

      // Attach image descriptions already computed at fingerprint time (free signal).
      const descById = new Map<string, string>();
      await Promise.all(
        posts.map(async (p) => {
          try {
            const fp = await getFingerprint(p.id);
            if (fp?.imageDescription) descById.set(p.id, fp.imageDescription);
          } catch {
            // ignore — empty stays
          }
        })
      );

      const rulesForClassify = rules.map((r) => ({ shortName: r.shortName, description: r.description }));
      const byId = new Map<string, Post>(posts.map((p) => [p.id, p]));

      // Batch the classification: one model call per ~10 posts, not per post.
      const BATCH = 10;
      const verdicts: RuleVerdict[] = [];
      for (let i = 0; i < posts.length; i += BATCH) {
        const slice = posts.slice(i, i + BATCH);
        const rows = slice.map((p) => ({
          postId: p.id,
          title: p.title,
          body: (p.body ?? '').slice(0, 500),
          linkDomain: urlDomain(p.url),
          imageDescription: descById.get(p.id) ?? '',
        }));
        const res = await classifyPostsAgainstRules(rulesForClassify, rows);
        for (const v of res) verdicts.push(v);
      }

      const violations = verdicts
        .filter((v) => v.violates && v.confidence >= minConfidence && byId.has(v.postId))
        .map((v) => {
          const p = byId.get(v.postId)!;
          return {
            postId: v.postId,
            rule: v.rule,
            confidence: v.confidence,
            reason: v.reason,
            title: p.title.slice(0, 140),
            author: p.authorName,
            permalink: p.permalink,
          };
        })
        .sort((a, b) => b.confidence - a.confidence);

      return {
        ok: true,
        summary: `Scanned ${posts.length} ${source} post(s); ${violations.length} likely violation(s) at ≥${minConfidence}% confidence.`,
        data: { scanned: posts.length, source, violations },
      };
    } catch (e) {
      return err(`scan_rule_violations failed: ${String(e)}`);
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
      const foreign = foreignSubError(post.subredditId);
      if (foreign) return err(foreign);
      await post.remove(isSpam);
      // If this post was a flagged repost, resolve the flag so it leaves the open
      // queue (keeps the detection store consistent after the post is removed).
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
      const foreign = foreignSubError(post.subredditId);
      if (foreign) return err(foreign);
      await post.approve();
      // Approving a flagged repost means the mod judged it NOT a repost — dismiss
      // the flag so it leaves the open queue (detection store stays consistent).
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
      const foreign = foreignSubError(post.subredditId);
      if (foreign) return err(foreign);
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
      const foreign = foreignSubError(c.subredditId);
      if (foreign) return err(foreign);
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

// ---------- AUTOMOD CONFIG (verified Devvit wiki APIs) ----------
// AutoModerator rules live in a wiki page at config/automoderator. The app's
// bot account was added as a moderator with the `moderator` scope at install
// (devvit.json permissions.reddit.scope), which covers wiki read/write — so
// getWikiPage / updateWikiPage work without any extra grant. Every edit is
// versioned by Reddit (getWikiPageRevisions / revertTo), so a bad write is
// recoverable from the wiki history.
const AUTOMOD_PAGE = 'config/automoderator';

// AutoMod YAML forbids literal tabs for indentation — a single tab silently
// breaks the whole config. Cheap structural guard before any write; the real
// safety net is the moderator approving the full content in the gate.
function automodSyntaxError(yaml: string): string | null {
  if (!yaml.trim()) return 'config is empty — refusing to write a blank automod page';
  if (/\t/.test(yaml)) return 'config contains tab characters — AutoMod requires spaces for indentation; replace tabs with spaces';
  return null;
}

const get_automod_config: ToolDef = {
  name: 'get_automod_config',
  category: 'read',
  description:
    'Read the subreddit\'s AutoModerator configuration — the raw YAML rules at the config/automoderator wiki page that auto-remove/filter/approve/report content. ' +
    'Use this to see what AutoMod already enforces BEFORE proposing a new rule (so you don\'t duplicate one), to explain in plain English what the current rules do, or to spot dead/conflicting rules. ' +
    'Returns the full YAML plus the last revision date/author. If the subreddit has no AutoMod config yet, returns ok with an empty config note.',
  parameters: { type: 'object', properties: {} },
  execute: async (_args, ctx) => {
    try {
      const page = await reddit.getWikiPage(ctx.subreddit, AUTOMOD_PAGE);
      const content = page.content ?? '';
      return {
        ok: true,
        summary: `Fetched AutoMod config for r/${ctx.subreddit} (${content.split('\n').length} lines).`,
        data: {
          content,
          lineCount: content.split('\n').length,
          empty: content.trim().length === 0,
          revisionDate: page.revisionDate?.toISOString?.() ?? null,
          revisionAuthor: page.revisionAuthor?.username ?? null,
          revisionReason: page.revisionReason ?? null,
        },
      };
    } catch (e) {
      // getWikiPage throws when the page doesn't exist (sub never set up AutoMod).
      const msg = String(e);
      if (/not found|404|does not exist|PAGE_NOT_CREATED|WIKI_DISABLED/i.test(msg)) {
        return {
          ok: true,
          summary: `r/${ctx.subreddit} has no AutoMod config yet.`,
          data: { content: '', lineCount: 0, empty: true, exists: false },
        };
      }
      return err(`get_automod_config failed: ${msg}`);
    }
  },
};

const update_automod_config: ToolDef = {
  name: 'update_automod_config',
  category: 'mutate',
  description:
    'Write the subreddit\'s AutoModerator config (config/automoderator wiki page). This is HIGH-IMPACT: a bad write affects every future post/comment, so ALWAYS call get_automod_config first and pass a precise `confirmation`. ' +
    'Two modes: pass `rule` to APPEND one new YAML rule block to the existing config (the safe default — preserves all current rules), or pass `content` to REPLACE the entire page (only when reworking the whole config; include every rule you want to keep). Pass exactly one of `rule` / `content`. ' +
    'AutoMod YAML is indentation-sensitive and must use spaces, never tabs. The edit is versioned in the wiki history and can be reverted by hand if wrong.',
  parameters: {
    type: 'object',
    required: ['confirmation'],
    properties: {
      rule: {
        type: 'string',
        description: 'A single AutoMod YAML rule block to append to the current config (preferred). Do NOT include a leading/trailing `---` separator — the tool inserts it.',
      },
      content: {
        type: 'string',
        description: 'The FULL replacement YAML for the entire page. Use only when rewriting the whole config; otherwise prefer `rule`.',
      },
      reason: { type: 'string', description: 'Short reason recorded in the wiki revision history.' },
      confirmation: CONFIRM_PROP,
    },
  },
  execute: async (args, ctx) => {
    const rule = requireString(args, 'rule');
    const content = requireString(args, 'content');
    const confirmation = requireString(args, 'confirmation');
    const reason = requireString(args, 'reason') || `ModPilot: AutoMod update by u/${ctx.actor}`;
    if (!confirmation) return err('confirmation required');
    if ((!rule && !content) || (rule && content)) {
      return err('pass exactly one of `rule` (append) or `content` (full replace)');
    }

    // Read the current page so append mode preserves existing rules, and so we
    // know whether to create vs update. Tolerate a missing page (new sub).
    let current = '';
    let exists = true;
    try {
      const page = await reddit.getWikiPage(ctx.subreddit, AUTOMOD_PAGE);
      current = page.content ?? '';
    } catch (e) {
      const msg = String(e);
      if (/not found|404|does not exist|PAGE_NOT_CREATED|WIKI_DISABLED/i.test(msg)) {
        exists = false;
      } else {
        return err(`update_automod_config: could not read current config: ${msg}`);
      }
    }

    let next: string;
    if (rule) {
      // The model often wraps the block in its own `---` separators despite the
      // instruction not to; strip leading/trailing ones so we don't accumulate
      // doubled/empty separators (harmless to AutoMod, but keeps the page clean).
      const block = (rule as string).trim().replace(/^-{3,}\s*\n/, '').replace(/\n\s*-{3,}\s*$/, '').trim();
      next = current.trim() ? `${current.trimEnd()}\n\n---\n\n${block}\n` : `${block}\n`;
    } else {
      next = (content as string).trimEnd() + '\n';
    }

    const syntax = automodSyntaxError(next);
    if (syntax) return err(`update_automod_config rejected: ${syntax}`);

    // Validate against the exact AutoMod schema BEFORE writing. Reddit validates
    // server-side and rejects invalid YAML as an opaque HTTP 415, so we catch
    // the syntax errors here and hand the model a precise message to fix — this
    // keeps the bad rule from ever reaching Reddit and lets the agent self-
    // correct within the loop.
    const check = validateAutomodConfig(next);
    if (!check.ok) {
      return err(
        `update_automod_config rejected — invalid AutoMod syntax (NOT written). Fix and retry:\n` +
          check.errors.map((e) => `  • ${e}`).join('\n')
      );
    }

    try {
      if (exists) {
        await reddit.updateWikiPage({ subredditName: ctx.subreddit, page: AUTOMOD_PAGE, content: next, reason });
      } else {
        await reddit.createWikiPage({ subredditName: ctx.subreddit, page: AUTOMOD_PAGE, content: next, reason });
      }
      return {
        ok: true,
        summary: rule
          ? `Appended a rule to AutoMod config for r/${ctx.subreddit} (now ${next.split('\n').length} lines).`
          : `Replaced AutoMod config for r/${ctx.subreddit} (${next.split('\n').length} lines).`,
        data: {
          mode: rule ? 'append' : 'replace',
          lineCount: next.split('\n').length,
          warnings: check.warnings.length ? check.warnings : undefined,
          confirmation,
        },
      };
    } catch (e) {
      const msg = String(e);
      // HTTP 415 / grpc status 2 here means Reddit's server-side AutoMod
      // validator REJECTED the YAML as invalid — the bad config was NOT saved.
      // The real validation message is swallowed by the transport (the error
      // response's content-type isn't what the gRPC client expects -> 415), so
      // tell the model exactly what to do: fix the syntax, don't retry verbatim.
      if (/415|status 2|UNKNOWN|invalid|malformed/i.test(msg)) {
        return err(
          'update_automod_config rejected by Reddit: the AutoMod YAML failed server-side validation and was NOT saved (surfaced as HTTP 415). ' +
            'This is a SYNTAX error in the rule, not a permission problem — valid rules save fine. ' +
            'Common cause: an unsupported check. AutoMod has NO `(length)` or `(empty)` modifier and no title/body length check. ' +
            'Use real checks only (e.g. `title+body (includes): [...]`, `domain: [...]`, `author: { post_karma: "< 50" }`). ' +
            'Revise the YAML and try a different rule — do not resend the same one.'
        );
      }
      if (/permission|forbidden|403|not allowed|unauthorized/i.test(msg)) {
        return err(`update_automod_config failed: ModPilot lacks wiki permission on r/${ctx.subreddit} — grant the app the "Manage Wiki Pages" moderator permission. (${msg})`);
      }
      return err(`update_automod_config failed: ${msg}`);
    }
  },
};

const create_subreddit_rule: ToolDef = {
  name: 'create_subreddit_rule',
  category: 'mutate',
  description:
    'Create a NEW official subreddit rule — the numbered rules shown in the sidebar and offered in the report dialog. ' +
    'This is DIFFERENT from AutoMod: subreddit rules are human-readable policy; creating one does NOT auto-action anything (use update_automod_config for automatic enforcement). ' +
    'Use this to put a policy on the books (e.g. "No reposts within 30 days"). ALWAYS call get_subreddit_rules first so you do not duplicate an existing rule. ' +
    'shortName must be unique (<= 100 chars); description shows on the sidebar; kind sets scope (all / link / comment).',
  parameters: {
    type: 'object',
    required: ['shortName', 'description', 'confirmation'],
    properties: {
      shortName: {
        type: 'string',
        description: 'Short, unique rule name shown as the rule title. Max 100 chars.',
      },
      description: {
        type: 'string',
        description: "Full rule text shown on the subreddit's sidebar.",
      },
      kind: {
        type: 'string',
        enum: ['all', 'link', 'comment'],
        description: 'What the rule applies to: all content, link/posts only, or comments only. Default: all.',
      },
      violationReason: {
        type: 'string',
        description: 'Optional text shown in the report form when users report under this rule. Defaults to shortName.',
      },
      confirmation: CONFIRM_PROP,
    },
  },
  execute: async (args, ctx) => {
    const shortName = requireString(args, 'shortName');
    const description = requireString(args, 'description');
    const kindRaw = requireString(args, 'kind') || 'all';
    const violationReason = requireString(args, 'violationReason');
    const confirmation = requireString(args, 'confirmation');
    if (!confirmation) return err('confirmation required');
    if (!shortName) return err('shortName required');
    if (!description) return err('description required');
    const kind = kindRaw === 'link' || kindRaw === 'comment' ? kindRaw : 'all';

    // Reddit requires shortName uniqueness and errors on a dup; pre-check for a
    // clean message instead of an opaque API error.
    try {
      const existing = await reddit.getRules(ctx.subreddit);
      if (
        existing.some(
          (r) => r.shortName.trim().toLowerCase() === shortName.trim().toLowerCase()
        )
      ) {
        return err(
          `a rule named "${shortName}" already exists — pick a different shortName (this tool only creates new rules).`
        );
      }
    } catch {
      // Couldn't list rules — proceed; createRule still rejects a duplicate.
    }

    try {
      const opts: Parameters<typeof reddit.createRule>[1] = {
        shortName: shortName.slice(0, 100),
        description,
        kind,
      };
      if (violationReason) opts.violationReason = violationReason;
      await reddit.createRule(ctx.subreddit, opts);
      return {
        ok: true,
        summary: `Created subreddit rule "${shortName}" (${kind}) on r/${ctx.subreddit}.`,
        data: { shortName, kind, confirmation },
      };
    } catch (e) {
      const msg = String(e);
      if (/exist|duplicate|unique|taken/i.test(msg)) {
        return err(`could not create rule — a rule with that name may already exist. (${msg})`);
      }
      if (/permission|forbidden|403|not allowed|unauthorized/i.test(msg)) {
        return err(
          `create_subreddit_rule failed: ModPilot lacks the "Manage Settings" moderator permission on r/${ctx.subreddit}. (${msg})`
        );
      }
      return err(`create_subreddit_rule failed: ${msg}`);
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
  check_post_for_repost,
  scan_rule_violations,
  describe_image,
  get_subreddit_rules,
  get_modqueue,
  get_modmail,
  get_modmail_thread,
  get_mod_notes,
  get_automod_config,
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
  update_automod_config,
  create_subreddit_rule,
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
