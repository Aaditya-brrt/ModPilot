import { settings } from '@devvit/web/server';

const CHAT_MODEL = 'gemini-2.5-flash';
const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

async function getApiKey(): Promise<string> {
  const key = await settings.get<string>('geminiApiKey');
  if (!key) {
    throw new Error('Gemini API key not configured. Set it in app settings (global).');
  }
  return key;
}

export type GeminiRole = 'user' | 'model' | 'function';

export type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export type GeminiMessage = {
  role: GeminiRole;
  parts: GeminiPart[];
};

export type FunctionDeclaration = {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type GeminiTurnResult = {
  text?: string;
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
  raw: unknown;
};

export async function chatTurn(
  history: GeminiMessage[],
  tools: FunctionDeclaration[],
  systemInstruction: string,
  turnLabel = 'turn'
): Promise<GeminiTurnResult> {
  const key = await getApiKey();
  const body = {
    contents: history,
    systemInstruction: { parts: [{ text: systemInstruction }] },
    tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
    toolConfig: tools.length > 0 ? { functionCallingConfig: { mode: 'AUTO' } } : undefined,
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
  };

  const roleSummary = history.map((m) => `${m.role}[${m.parts.length}p]`).join(' → ');
  console.log(
    `[modpilot:llm] ${turnLabel} → POST ${CHAT_MODEL}:generateContent | history(${history.length}) ${roleSummary} | tools=${tools.length}`
  );
  // Dump just the last 2 messages to show what the model is reacting to.
  const tail = history.slice(-2);
  for (const m of tail) {
    for (const p of m.parts) {
      if ('text' in p) {
        console.log(`[modpilot:llm]   ${m.role}.text: ${p.text.slice(0, 240)}`);
      } else if ('functionCall' in p) {
        console.log(
          `[modpilot:llm]   ${m.role}.functionCall: ${p.functionCall.name}(${JSON.stringify(p.functionCall.args).slice(0, 200)})`
        );
      } else if ('functionResponse' in p) {
        console.log(
          `[modpilot:llm]   ${m.role}.functionResponse: ${p.functionResponse.name} = ${JSON.stringify(p.functionResponse.response).slice(0, 200)}`
        );
      }
    }
  }

  const t0 = Date.now();
  const res = await fetch(
    `${baseUrl}/models/${CHAT_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const ms = Date.now() - t0;

  if (!res.ok) {
    const errBody = await res.text();
    console.error(
      `[modpilot:llm] ${turnLabel} ← HTTP ${res.status} after ${ms}ms: ${errBody.slice(0, 400)}`
    );
    throw new Error(`Gemini chat failed ${res.status}: ${errBody.slice(0, 400)}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: GeminiPart[] };
      finishReason?: string;
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const finishReason = json.candidates?.[0]?.finishReason ?? '?';
  const promptTokens = json.usageMetadata?.promptTokenCount ?? 0;
  const replyTokens = json.usageMetadata?.candidatesTokenCount ?? 0;
  const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let textOut = '';
  for (const p of parts) {
    if ('text' in p && typeof p.text === 'string') textOut += p.text;
    else if ('functionCall' in p && p.functionCall) {
      functionCalls.push({
        name: p.functionCall.name,
        args: (p.functionCall.args ?? {}) as Record<string, unknown>,
      });
    }
  }

  console.log(
    `[modpilot:llm] ${turnLabel} ← ${ms}ms finishReason=${finishReason} tokens(prompt=${promptTokens}, reply=${replyTokens}) calls=${functionCalls.length} textLen=${textOut.length}`
  );
  if (functionCalls.length > 0) {
    for (const fc of functionCalls) {
      console.log(`[modpilot:llm]   → call ${fc.name}(${JSON.stringify(fc.args).slice(0, 300)})`);
    }
  }
  if (textOut) {
    console.log(`[modpilot:llm]   → text: ${textOut.slice(0, 400)}`);
  }

  const out: GeminiTurnResult = { functionCalls, raw: json };
  if (textOut) out.text = textOut;
  return out;
}

export async function* streamChatText(
  history: GeminiMessage[],
  systemInstruction: string
): AsyncGenerator<string, void, void> {
  const key = await getApiKey();
  const body = {
    contents: history,
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
  };
  const res = await fetch(
    `${baseUrl}/models/${CHAT_MODEL}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok || !res.body) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Gemini stream failed ${res.status}: ${errBody.slice(0, 400)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = obj.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) yield text;
      } catch {
        // ignore partial json
      }
    }
  }
}
