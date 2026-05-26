// Minimal structural parser for AutoModerator YAML — enough to VALIDATE keys,
// modifiers and directive values before a write. It does NOT build a full match
// AST (that's the Phase 2 engine); it extracts the key lines of each rule block
// so the validator can check them against the schema.

export type ParsedLine = {
  lineNo: number;
  indent: number;
  rawKey: string; // text before the first colon, e.g. "title+body (includes)"
  value: string; // text after the first colon (may be empty for sections / block lists)
};

export type RuleBlock = {
  index: number; // 0-based block number within the file
  lines: ParsedLine[];
};

export type FieldSpec = {
  negate: boolean; // leading ~
  fields: string[]; // split on + (e.g. ["title","body"])
  modifiers: string[]; // contents of the trailing (..) group
};

// Split the file into rule blocks on lines that are exactly `---`, then capture
// each block's key lines (skipping comments, blanks and value-only list items).
export function parseConfig(text: string): RuleBlock[] {
  const blocks: RuleBlock[] = [];
  let current: ParsedLine[] = [];
  let blockIndex = 0;
  const rawLines = text.split('\n');

  const flush = () => {
    if (current.length > 0) {
      blocks.push({ index: blockIndex++, lines: current });
      current = [];
    }
  };

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed === '---') {
      flush();
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    // value-only list item (e.g. `  - "spam"`) — not a key line
    if (trimmed.startsWith('-')) continue;

    const colon = raw.indexOf(':');
    if (colon === -1) continue; // not a key line we can validate

    const indent = raw.length - raw.trimStart().length;
    const rawKey = raw.slice(indent, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (!rawKey) continue;
    current.push({ lineNo: i + 1, indent, rawKey, value });
  }
  flush();
  return blocks;
}

// Decode a key like "~title+body (includes, case-sensitive)" into its parts.
export function parseFieldSpec(rawKey: string): FieldSpec {
  let key = rawKey.trim();
  const negate = key.startsWith('~');
  if (negate) key = key.slice(1).trim();

  let modifiers: string[] = [];
  const m = key.match(/\(([^)]*)\)\s*$/);
  if (m) {
    modifiers = (m[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    key = key.slice(0, m.index).trim();
  }
  const fields = key
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  return { negate, fields, modifiers };
}
