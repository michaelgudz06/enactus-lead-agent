// DeepSeek via OpenRouter. R1 for visible reasoning, V3 (chat) for fast structured work.
const OR_URL = "https://openrouter.ai/api/v1/chat/completions";

export const REASONER = "deepseek/deepseek-r1";
const CHAT = "deepseek/deepseek-chat";

// Structuring model. Re-benchmarked 2026-08-15 on the real payload (15
// candidates in, 10 leads out, 3 rounds per model). Numbers are wall-clock ms
// through OpenRouter:
//
//   deepseek/deepseek-v3.2  @Baidu   887-1470   10/10 leads, always finish=stop
//   google/gemini-2.5-flash-lite      564-1288   10/10 leads, stable shape
//   google/gemini-3.7-flash          1805 avg    10/10 leads, ~5x the output cost
//   google/gemini-3.5-flash-lite      698-1361   SHAPE-UNSTABLE (see pluck)
//   google/gemini-3.1-flash-lite      801-911    SHAPE-UNSTABLE (see pluck)
//   deepseek/deepseek-v4-pro-0813     576-2154   TRUNCATES: finish=length @4k
//   deepseek/deepseek-v4-flash        801 @Baidu but TRUNCATES @Alibaba
//
// v3.2@Baidu wins on latency, cost and reliability together, so it stays.
// Fallbacks stay on so a provider outage degrades to "slow", not "failed".
//
// Note for future tuning: an earlier session recorded 15.7-17.5s for this same
// call and sized the whole time budget around it. Re-measuring put it near 1s.
// Provider latency drifts a lot week to week -- re-run scripts/bench before
// trusting any number in this comment.
export const STRUCTURER = "deepseek/deepseek-v3.2";
export const STRUCTURER_PROVIDER = { order: ["Baidu"], allow_fallbacks: true };

/**
 * Pull an array out of a model response that may or may not have wrapped it.
 *
 * Asked for {"leads":[...]}, gemini-3.5-flash-lite and gemini-3.1-flash-lite
 * were measured returning a bare top-level [...] on roughly half of otherwise
 * identical calls. Tolerating both shapes is a two-line code guard; asking the
 * model more firmly is not a guard at all.
 */
export function pluck<T = unknown>(parsed: unknown, key: string): T[] | null {
  if (Array.isArray(parsed)) return parsed as T[];
  if (parsed && typeof parsed === "object") {
    const direct = (parsed as Record<string, unknown>)[key];
    if (Array.isArray(direct)) return direct as T[];
    // Last resort: a single array-valued property under any name.
    const arrays = Object.values(parsed as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as T[];
  }
  return null;
}

export function hasLLMKey() {
  const k = process.env.OPENROUTER_API_KEY;
  return Boolean(k && !k.startsWith("REPLACE"));
}

type Msg = { role: "system" | "user" | "assistant"; content: string };

function headers() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://enactus-agent.local",
    "X-Title": "Enactus SFU Lead Agent",
  };
}

// Non-streaming JSON completion (used for planning + scoring synthesis when we
// don't need to show reasoning live).
export async function chatJSON<T = unknown>(
  messages: Msg[],
  opts: { model?: string; maxTokens?: number; signal?: AbortSignal; provider?: unknown } = {}
): Promise<T> {
  // Timing is logged because this call is the one that must fit inside the
  // function cap, and identical payloads have measured 1s standalone versus
  // far longer in-app. Without a mark here that gap is invisible from prod.
  const t0 = Date.now();
  const res = await fetch(OR_URL, {
    method: "POST",
    headers: headers(),
    signal: opts.signal,
    cache: "no-store",
    body: JSON.stringify({
      model: opts.model ?? CHAT,
      messages,
      max_tokens: opts.maxTokens ?? 1500,
      temperature: 0.3,
      response_format: { type: "json_object" },
      ...(opts.provider ? { provider: opts.provider } : {}),
    }),
  });
  const headersAt = Date.now() - t0;
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  console.log(
    `[llm] ${opts.model ?? CHAT} headers=${headersAt}ms body=${Date.now() - t0}ms ` +
      `provider=${data?.provider} finish=${data?.choices?.[0]?.finish_reason} out=${data?.usage?.completion_tokens}`
  );
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  return extractJSON<T>(content);
}

// Streaming call that surfaces both the reasoning trace and the final content.
//
// Used for both LLM stages. Streaming is not cosmetic for the structuring
// stage: a non-streaming call that overruns its budget returns nothing at all,
// while a streamed one leaves a partial body that salvageObjects can still
// recover finished leads from.
export async function streamReasoner(
  messages: Msg[],
  handlers: { onReasoning?: (delta: string) => void; onContent?: (delta: string) => void },
  opts: {
    model?: string;
    maxTokens?: number;
    signal?: AbortSignal;
    fastProvider?: boolean;
    provider?: unknown;
    temperature?: number;
    json?: boolean;
  } = {}
): Promise<{ reasoning: string; content: string }> {
  const body: Record<string, unknown> = {
    model: opts.model ?? REASONER,
    messages,
    max_tokens: opts.maxTokens ?? 2400,
    temperature: opts.temperature ?? 0.4,
    stream: true,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  if (opts.provider) body.provider = opts.provider;
  // Route to the highest-throughput provider so R1 finishes within our time budget.
  if (opts.fastProvider) body.provider = { sort: "throughput" };

  const res = await fetch(OR_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`OpenRouter ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reasoning = "";
  let content = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta ?? {};
          const r: string | undefined = delta.reasoning ?? delta.reasoning_content;
          const c: string | undefined = delta.content;
          if (r) {
            reasoning += r;
            handlers.onReasoning?.(r);
          }
          if (c) {
            content += c;
            handlers.onContent?.(c);
          }
        } catch {
          // ignore partial/non-JSON keepalive lines
        }
      }
    }
  } catch (e) {
    // On a time-budget abort, keep whatever reasoning we streamed so far and
    // let the caller proceed to structuring. Re-throw genuine errors.
    if (!(opts.signal?.aborted || (e as Error)?.name === "AbortError")) throw e;
  }
  return { reasoning, content };
}

/**
 * Recover every COMPLETE object from a JSON array body that may be truncated,
 * unterminated, or otherwise unparseable as a whole.
 *
 * The structuring call emits leads one after another, so a body cut off
 * mid-flight still contains N finished leads followed by a partial one. Parsing
 * the whole string throws and yields zero; scanning for balanced objects yields
 * N. Given the provider's latency swings by 10x between identical calls, "8 of
 * the 10 you asked for" is the difference between a usable run and a dead one.
 *
 * String-aware, because a brace inside "why_fit" would otherwise unbalance the
 * scan and drop every lead after it.
 */
export function salvageObjects(text: string): unknown[] {
  const from = text.indexOf("["); // skip the {"leads": wrapper; a bare array starts here too
  if (from === -1) return [];
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = from + 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0 && --depth === 0 && start !== -1) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // Not a lead object we can use; keep scanning for the next one.
        }
        start = -1;
      }
    }
  }
  return out;
}

// Robustly pull a JSON object/array out of a model response that may be fenced.
export function extractJSON<T = unknown>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]) as T;
    } catch {
      // fall through
    }
  }
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  }
  throw new Error("Could not parse JSON from model output");
}
