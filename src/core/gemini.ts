import { settings } from '@devvit/web/server';

const EMBED_MODEL = 'gemini-embedding-2';
const VISION_MODEL = 'gemini-2.5-flash';
const EMBED_DIM = 768;
// Upper bound on image bytes we'll inline to Gemini vision. Gemini downscales /
// tiles large images server-side for token cost, so we don't resize client-side
// (that needs an image-decode dep that won't bundle for Devvit). 5MB covers
// effectively all Reddit photos while keeping the base64 request body (~6.7MB)
// well under the inline-data ceiling. Anything larger is skipped, not resized.
const MAX_IMAGE_BYTES = 5_000_000;

const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

async function getApiKey(): Promise<string> {
  const key = await settings.get<string>('geminiApiKey');
  if (!key) {
    throw new Error(
      'Gemini API key not configured. Set it in app settings (global).'
    );
  }
  return key;
}

export async function embedText(text: string): Promise<Float32Array> {
  const key = await getApiKey();
  const trimmed = text.slice(0, 8000);

  const res = await fetch(
    `${baseUrl}/models/${EMBED_MODEL}:embedContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text: trimmed }] },
        outputDimensionality: EMBED_DIM,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini embed failed ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    embedding?: { values?: number[] };
  };
  const values = json.embedding?.values;
  if (!values || values.length !== EMBED_DIM) {
    throw new Error(
      `Gemini embed returned unexpected payload (len=${values?.length ?? 'none'})`
    );
  }
  return Float32Array.from(values);
}

export async function describeImage(imageUrl: string): Promise<string> {
  const key = await getApiKey();

  let knownSize: number | undefined;
  try {
    const head = await fetch(imageUrl, { method: 'HEAD' });
    const cl = head.headers.get('content-length');
    if (cl) knownSize = Number(cl);
  } catch {
    // HEAD not always supported; fall through to GET
  }
  if (knownSize != null && knownSize > MAX_IMAGE_BYTES) {
    console.log(
      `[modpilot:repost] vision skip (HEAD ${knownSize}B > ${MAX_IMAGE_BYTES}B): ${imageUrl}`
    );
    return '';
  }

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Image fetch failed ${imgRes.status} for ${imageUrl}`);
  }
  const mime = imgRes.headers.get('content-type') ?? 'image/jpeg';
  const buf = await imgRes.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    console.log(
      `[modpilot:repost] vision skip (GET ${buf.byteLength}B > ${MAX_IMAGE_BYTES}B): ${imageUrl}`
    );
    return '';
  }
  const b64 = bufferToBase64(buf);

  const res = await fetch(
    `${baseUrl}/models/${VISION_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: 'Describe this image in 2 short sentences. Focus on distinctive subjects, composition, colors, and any text. Do not speculate about context.',
              },
              { inlineData: { mimeType: mime, data: b64 } },
            ],
          },
        ],
        generationConfig: { temperature: 0.2, maxOutputTokens: 120 },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini vision failed ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  return text ?? '';
}

function bufferToBase64(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('base64');
}

// ---------- rule-violation classification ----------

const CLASSIFY_MODEL = 'gemini-2.5-flash';

export type RuleForClassify = { shortName: string; description: string };
export type PostForClassify = {
  postId: string;
  title: string;
  body?: string;
  linkDomain?: string;
  imageDescription?: string;
};
export type RuleVerdict = {
  postId: string;
  violates: boolean;
  rule: string; // exact rule shortName it violates, or '' if none
  confidence: number; // 0-100
  reason: string;
};

// Judge a BATCH of posts against the subreddit rules in ONE Gemini call (instead
// of one call per post). Returns a verdict per post. Uses JSON response mode; the
// parser also strips markdown fences so a non-JSON-mode response still parses.
export async function classifyPostsAgainstRules(
  rules: RuleForClassify[],
  posts: PostForClassify[]
): Promise<RuleVerdict[]> {
  if (rules.length === 0 || posts.length === 0) return [];
  const key = await getApiKey();

  const ruleBlock = rules
    .map((r, i) => `${i + 1}. "${r.shortName}": ${r.description.slice(0, 400)}`)
    .join('\n');
  const postBlock = posts
    .map((p) => {
      const bits = [`id: ${p.postId}`, `title: ${p.title.slice(0, 200)}`];
      if (p.body) bits.push(`body: ${p.body.slice(0, 500)}`);
      if (p.linkDomain) bits.push(`link_domain: ${p.linkDomain}`);
      if (p.imageDescription) bits.push(`image: ${p.imageDescription.slice(0, 200)}`);
      return `- ${bits.join('\n  ')}`;
    })
    .join('\n');

  const prompt =
    `You are a strict but fair Reddit rule-compliance checker for one subreddit.\n\n` +
    `RULES:\n${ruleBlock}\n\n` +
    `POSTS:\n${postBlock}\n\n` +
    `For EACH post, decide whether it CLEARLY violates one of the rules above. ` +
    `Judge only the post's own content. When genuinely in doubt, set violates=false. ` +
    `Do not invent rules — only use the ones listed.\n\n` +
    `Return ONLY a JSON array, one object per post (same order):\n` +
    `[{"postId": string, "violates": boolean, "rule": string (exact rule shortName, or "" if none), ` +
    `"confidence": number 0-100, "reason": string — <=20 words quoting the triggering text}]`;

  const res = await fetch(
    `${baseUrl}/models/${CLASSIFY_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        },
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini classify failed ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  };
  const cand = json.candidates?.[0];
  // Gemini can split one response across MULTIPLE text parts — concatenate them
  // all. Reading only parts[0] yields a truncated fragment that fails to parse,
  // silently dropping every verdict (and so every real violation).
  const text = (cand?.content?.parts ?? [])
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('');
  const verdicts = parseVerdicts(text);
  if (verdicts.length === 0 && text.trim().length > 0) {
    console.warn(
      `[modpilot:rules] classify yielded 0 verdicts (finishReason=${cand?.finishReason ?? '?'}, len=${text.length})`
    );
  }
  return verdicts;
}

function tryParseArray(s: string): unknown[] | null {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function parseVerdicts(text: string): RuleVerdict[] {
  let raw = text.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  let arr = tryParseArray(raw);
  // Salvage a truncated array (response cut mid-object): keep everything through
  // the last complete object and close the bracket, so partial batches still count.
  if (!arr) {
    const lastBrace = raw.lastIndexOf('}');
    if (lastBrace > 0) arr = tryParseArray(raw.slice(0, lastBrace + 1) + ']');
  }
  if (!arr) {
    console.warn('[modpilot:rules] classify JSON parse failed:', raw.slice(0, 200));
    return [];
  }
  const out: RuleVerdict[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const postId = typeof o.postId === 'string' ? o.postId : '';
    if (!postId) continue;
    out.push({
      postId,
      violates: o.violates === true,
      rule: typeof o.rule === 'string' ? o.rule : '',
      confidence: typeof o.confidence === 'number' ? o.confidence : 0,
      reason: typeof o.reason === 'string' ? o.reason : '',
    });
  }
  return out;
}

export const __embedDim = EMBED_DIM;
