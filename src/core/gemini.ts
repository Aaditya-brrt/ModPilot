import { settings } from '@devvit/web/server';

const EMBED_MODEL = 'gemini-embedding-2';
const VISION_MODEL = 'gemini-2.5-flash';
const EMBED_DIM = 768;
const MAX_IMAGE_BYTES = 200_000;

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

export const __embedDim = EMBED_DIM;
