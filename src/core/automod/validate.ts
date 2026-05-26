// Validate a full AutoModerator config string against the exact schema. Returns
// hard `errors` (block the write — these are what Reddit rejects as HTTP 415)
// and soft `warnings` (unrecognized keys we don't enumerate; don't block, since
// AutoMod has a long tail of keys). Conservative on purpose: only flag things
// that are definitely wrong, so we never block a legitimate rule.

import { parseConfig, parseFieldSpec, type ParsedLine } from './parse';
import {
  ACTIONS,
  AUTHOR_BOOLEAN_KEYS,
  AUTHOR_NUMERIC_KEYS,
  AUTHOR_SEARCH_FIELDS,
  BOOLEAN_KEYS,
  isKnownDirective,
  MODIFIERS,
  NUMERIC_KEYS,
  SEARCH_FIELDS,
  SECTION_KEYS,
  SUGGESTED_SORTS,
  TYPE_VALUES,
} from './schema';

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

const BOOL_RE = /^(true|false|yes|no|on|off)$/i;
const NUM_COMPARE_RE = /\d/; // must contain a digit; operator/units optional

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Resolve which section a line belongs to, given the running section stack.
function currentSection(stack: Array<{ indent: number; key: string }>): string | null {
  return stack.length ? (stack[stack.length - 1]?.key ?? null) : null;
}

function validateLine(
  line: ParsedLine,
  section: string | null,
  errors: string[],
  warnings: string[]
): void {
  const where = `line ${line.lineNo} ("${line.rawKey}")`;
  const spec = parseFieldSpec(line.rawKey);
  const base = spec.fields[0] ?? '';

  // 1. Keys with (modifiers): every modifier must be a real AutoMod modifier.
  //    This is the check that catches `title (length)` / `body (empty)`.
  if (spec.modifiers.length > 0) {
    for (const mod of spec.modifiers) {
      if (!MODIFIERS.has(mod)) {
        if (mod === 'length') {
          errors.push(
            `${where}: "(length)" is not a valid AutoMod modifier. There is no length modifier — use the \`body_longer_than\` / \`body_shorter_than\` keys instead.`
          );
        } else if (mod === 'empty') {
          errors.push(
            `${where}: "(empty)" is not a valid AutoMod modifier. For an empty body use \`body_shorter_than: 1\`.`
          );
        } else {
          errors.push(
            `${where}: "(${mod})" is not a valid AutoMod modifier. Valid: ${[...MODIFIERS].join(', ')}.`
          );
        }
      }
    }
    // base field sanity (warn only — don't block on an unrecognized subject)
    const allowed = section === 'author' ? AUTHOR_SEARCH_FIELDS : SEARCH_FIELDS;
    for (const f of spec.fields) {
      if (!allowed.has(f)) {
        warnings.push(`${where}: "${f}" is not a recognized search field${section ? ` in the ${section} section` : ''}.`);
      }
    }
    return;
  }

  // 2. No modifiers — a directive, condition, section header, or bare search field.
  const key = base;
  const value = stripQuotes(line.value);

  if (key === 'action') {
    if (value && !ACTIONS.has(value.toLowerCase())) {
      errors.push(`${where}: action "${value}" is invalid. Valid: ${[...ACTIONS].join(', ')}.`);
    }
    return;
  }
  if (key === 'type') {
    if (value && !TYPE_VALUES.has(value.toLowerCase())) {
      errors.push(`${where}: type "${value}" is invalid. Valid: ${[...TYPE_VALUES].join(', ')}.`);
    }
    return;
  }
  if (key === 'set_suggested_sort') {
    if (value && !SUGGESTED_SORTS.has(value.toLowerCase())) {
      errors.push(`${where}: set_suggested_sort "${value}" is invalid.`);
    }
    return;
  }
  if (key === 'priority') {
    if (value && !/^-?\d+$/.test(value)) errors.push(`${where}: priority must be an integer.`);
    return;
  }

  const numeric = NUMERIC_KEYS.has(key) || (section === 'author' && AUTHOR_NUMERIC_KEYS.has(key));
  if (numeric) {
    if (value && !NUM_COMPARE_RE.test(value)) {
      errors.push(`${where}: "${key}" expects a number or comparison (e.g. "> 100", "< 5", "5 days"), got "${value}".`);
    }
    return;
  }

  const boolean = BOOLEAN_KEYS.has(key) || (section === 'author' && AUTHOR_BOOLEAN_KEYS.has(key));
  if (boolean) {
    if (value && !BOOL_RE.test(value)) {
      warnings.push(`${where}: "${key}" usually takes true/false, got "${value}".`);
    }
    return;
  }

  // Section header (empty value, known section) or bare search field — fine.
  if (SECTION_KEYS.has(key)) return;
  const allowedBare = section === 'author' ? AUTHOR_SEARCH_FIELDS : SEARCH_FIELDS;
  if (allowedBare.has(key)) return;
  if (isKnownDirective(key)) return;

  // Unknown key — soft warning only (AutoMod has a long tail of keys).
  warnings.push(`${where}: "${key}" is not a recognized AutoMod key${section ? ` in the ${section} section` : ''}.`);
}

export function validateAutomodConfig(text: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (/\t/.test(text)) {
    errors.push('Config contains tab characters — AutoMod requires spaces for indentation.');
  }

  const blocks = parseConfig(text);
  if (blocks.length === 0 && text.trim()) {
    warnings.push('No rule blocks parsed — check that blocks are separated by lines containing only `---`.');
  }

  for (const block of blocks) {
    let sawAction = false;
    const stack: Array<{ indent: number; key: string }> = [];
    for (const line of block.lines) {
      // pop sections we've dedented out of
      while (stack.length && (stack[stack.length - 1]?.indent ?? -1) >= line.indent) stack.pop();
      const section = currentSection(stack);

      validateLine(line, section, errors, warnings);

      const spec = parseFieldSpec(line.rawKey);
      const key = spec.fields[0] ?? '';
      if (key === 'action' || key === 'set_flair' || key === 'comment' || key === 'report' || key === 'set_locked' || key === 'set_nsfw' || key === 'set_spoiler' || key === 'set_sticky' || key === 'set_contest_mode' || key === 'modmail' || key === 'message') {
        sawAction = true;
      }
      // a section header has an empty value and a known section name
      if (spec.modifiers.length === 0 && line.value === '' && SECTION_KEYS.has(key)) {
        stack.push({ indent: line.indent, key });
      }
    }
    if (!sawAction) {
      warnings.push(`Rule block #${block.index + 1} has no action (action/set_flair/comment/…) — it will match but do nothing.`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
