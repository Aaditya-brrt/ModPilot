// Exact AutoModerator schema constants, sourced from Reddit's engine
// (reddit-archive/reddit r2/r2/lib/automoderator.py). Used to validate a config
// BEFORE writing it to the config/automoderator wiki page — Reddit validates
// server-side and rejects invalid YAML as an opaque HTTP 415, so we catch the
// common syntax errors locally first and hand the model a precise message.

// Search-check subjects that accept (modifier) groups + value lists.
export const SEARCH_FIELDS = new Set<string>([
  'id',
  'title',
  'body',
  'domain',
  'url',
  'media_author',
  'media_author_url',
  'media_title',
  'media_description',
  'flair_text',
  'flair_css_class',
  // author-section search subjects
  'name',
]);

// Match modifiers that may appear inside (parentheses). THE list — anything
// else (e.g. `length`, `empty`) is invalid and is what produced the 415s.
export const MODIFIERS = new Set<string>([
  'includes',
  'includes-word',
  'starts-with',
  'ends-with',
  'full-exact',
  'full-text',
  'regex',
  'case-sensitive',
]);

export const ACTIONS = new Set<string>(['approve', 'remove', 'spam', 'filter', 'report']);

export const TYPE_VALUES = new Set<string>([
  'comment',
  'submission',
  'link submission',
  'text submission',
  'crosspost submission',
  'any',
]);

export const SUGGESTED_SORTS = new Set<string>([
  'confidence',
  'new',
  'top',
  'qa',
  'old',
  'live',
  'best',
  'controversial',
  'random',
]);

// Keys whose value is a number / comparison ("> 100", "< 5", "5 days").
export const NUMERIC_KEYS = new Set<string>([
  'post_karma',
  'link_karma',
  'comment_karma',
  'combined_karma',
  'account_age',
  'reports',
  'body_longer_than',
  'body_shorter_than',
]);

// Keys whose value is a boolean.
export const BOOLEAN_KEYS = new Set<string>([
  'is_edited',
  'is_top_level',
  'is_submitter',
  'is_moderator',
  'is_contributor',
  'is_gold',
  'overwrite_flair',
  'set_nsfw',
  'set_spoiler',
  'set_locked',
  'set_contest_mode',
  'set_original_content',
  'comment_stickied',
  'comment_locked',
  'ignore_blockquotes',
  'moderators_exempt',
]);

// Free-form / enum directive keys (value shape validated case-by-case).
export const STRING_KEYS = new Set<string>([
  'action_reason',
  'report_reason',
  'set_flair',
  'set_sticky',
  'set_suggested_sort',
  'comment',
  'modmail',
  'modmail_subject',
  'message',
  'message_subject',
  'flair_text',
  'flair_css_class',
  'flair_template_id',
  'search_query',
]);

// Section headers that introduce nested checks.
export const SECTION_KEYS = new Set<string>(['author', 'crosspost_author', 'crosspost_subreddit']);

// Author-section subjects.
export const AUTHOR_SEARCH_FIELDS = new Set<string>(['name', 'id', 'flair_text', 'flair_css_class']);
export const AUTHOR_NUMERIC_KEYS = new Set<string>([
  'post_karma',
  'link_karma',
  'comment_karma',
  'combined_karma',
  'account_age',
]);
export const AUTHOR_BOOLEAN_KEYS = new Set<string>([
  'is_gold',
  'is_contributor',
  'is_moderator',
  'is_submitter',
]);

// All top-level meta/action/condition keys that are NOT search fields.
export function isKnownDirective(key: string): boolean {
  return (
    key === 'type' ||
    key === 'priority' ||
    key === 'action' ||
    NUMERIC_KEYS.has(key) ||
    BOOLEAN_KEYS.has(key) ||
    STRING_KEYS.has(key) ||
    SECTION_KEYS.has(key)
  );
}
