import { settings } from '@devvit/web/server';

const CHAT_MODEL = 'gemini-2.5-flash';
const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

// Rough token estimate from serialized size (~4 chars/token). Used only for the
// composition breakdown in logs — the authoritative count is Gemini's
// usageMetadata.promptTokenCount. Lets us see WHERE the prompt budget goes
// (system + tools vs history) since the API only returns one opaque total.
function approxTokens(v: unknown): number {
  return Math.round(JSON.stringify(v).length / 4);
}

// Cumulative token spend per session, keyed by session id parsed from turnLabel
// ("s_xxx#4" -> "s_xxx"). PROCESS-LOCAL: Devvit may serve turns across separate
// invocations, so this resets when the process cycles — a within-run gauge, not
// a durable ledger.
const SESSION_TOKENS = new Map<string, { prompt: number; reply: number; turns: number }>();

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
  finishReason: string;
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
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
  };

  const roleSummary = history.map((m) => `${m.role}[${m.parts.length}p]`).join(' → ');
  console.log(
    `[modpilot:llm] ${turnLabel} → POST ${CHAT_MODEL}:generateContent | history(${history.length}) ${roleSummary} | tools=${tools.length}`
  );
  // Composition breakdown: how the prompt budget splits across the fixed prefix
  // (system + tool schemas, re-sent every turn) vs the growing history, plus the
  // single heaviest history message so fat tool-result/fan-out turns are visible.
  const sysEst = approxTokens(systemInstruction);
  const toolsEst = approxTokens(tools);
  const histEst = approxTokens(history);
  let biggest = 0;
  let biggestIdx = -1;
  let biggestRole = '';
  history.forEach((m, i) => {
    const t = approxTokens(m);
    if (t > biggest) {
      biggest = t;
      biggestIdx = i;
      biggestRole = m.role;
    }
  });
  console.log(
    `[modpilot:llm]   est total≈${sysEst + toolsEst + histEst} = prefix≈${sysEst + toolsEst} (sys ${sysEst} + tools ${toolsEst}) + history≈${histEst} (${history.length} msgs, biggest #${biggestIdx} ${biggestRole} ≈${biggest})`
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
  // Accumulate process-local session spend so the cost of re-sending history
  // across turns is visible as a running total, not just per-call.
  const sid = turnLabel.split('#')[0] ?? turnLabel;
  const prev = SESSION_TOKENS.get(sid) ?? { prompt: 0, reply: 0, turns: 0 };
  const agg = {
    prompt: prev.prompt + promptTokens,
    reply: prev.reply + replyTokens,
    turns: prev.turns + 1,
  };
  SESSION_TOKENS.set(sid, agg);
  console.log(
    `[modpilot:llm]   session ${sid} cumulative: prompt=${agg.prompt} reply=${agg.reply} (total=${agg.prompt + agg.reply}) over ${agg.turns} turn(s), process-local`
  );
  if (functionCalls.length > 0) {
    for (const fc of functionCalls) {
      console.log(`[modpilot:llm]   → call ${fc.name}(${JSON.stringify(fc.args).slice(0, 300)})`);
    }
  }
  if (textOut) {
    console.log(`[modpilot:llm]   → text: ${textOut.slice(0, 400)}`);
  }

  const out: GeminiTurnResult = { functionCalls, finishReason, raw: json };
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
