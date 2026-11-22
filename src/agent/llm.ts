import { randomUUID } from "node:crypto";

export interface ToolCall {
  id: string; type: "function"; function: { name: string; arguments: string };
  /** Provider extras that must be echoed back unchanged (Gemini 3 puts its thought signature here). */
  extra_content?: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmClient {
  complete(input: { messages: ChatMessage[]; tools: ToolDefinition[] }): Promise<ChatMessage>;
}

interface Attempt { response?: Response; error?: LlmError; kind: "ok" | "transient" | "rate-limited" | "permanent"; retryAfterMs?: number }

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "LlmError"; }
}

/**
 * OpenAI-compatible Chat Completions client with native function/tool calling.
 * Works with OpenAI, and with Google Gemini through its OpenAI-compatible endpoint
 * (LLM_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai, LLM_MODEL=gemini-3.5-flash).
 */
/** Placeholder Google documents for function calls that did not come from the model (Gemini 3 validates signatures). */
export const GEMINI_SKIP_SIGNATURE = "skip_thought_signature_validator";

export class OpenAiCompatibleClient implements LlmClient {
  constructor(private readonly config: { apiKey: string; baseUrl: string; model: string; timeoutMs?: number; retryDelayMs?: number }) {}

  private get isGemini() { return /generativelanguage\.googleapis\.com/.test(this.config.baseUrl); }

  /** Gemini 3 rejects function calls without a thought signature. Real signatures from the model are echoed back untouched;
   *  tool calls the agent created itself (the confirmed payment) get Google's documented placeholder. */
  private prepareMessages(messages: ChatMessage[]): ChatMessage[] {
    if (!this.isGemini) return messages;
    return messages.map((m) => m.role === "assistant" && m.tool_calls?.length
      ? { ...m, tool_calls: m.tool_calls.map((c) => c.extra_content ? c : { ...c, extra_content: { google: { thought_signature: GEMINI_SKIP_SIGNATURE } } }) }
      : m);
  }

  /** Google recommends the default temperature for Gemini 3 models; other models get a low temperature for stable tool use. */
  private get temperature(): number | undefined {
    return this.isGemini && /^gemini-(3|flash-latest|pro-latest)/.test(this.config.model) ? undefined : 0.1;
  }

  /** One HTTP attempt. Timeouts, 5xx and 429 are transient; anything else (401, 404, 400 ...) is not. */
  private async attempt(body: string): Promise<Attempt> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 90_000),
      });
    } catch (error: any) {
      return { error: new LlmError(`LLM request failed: ${error?.message ?? error}`), kind: "transient" };
    }
    if (response.ok) return { response, kind: "ok" };
    const text = await response.text().catch(() => "");
    const detail = text.replace(/\s+/g, " ").slice(0, 700);
    const error = new LlmError(`LLM provider returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
    if (response.status === 429) {
      // A daily/monthly quota will not recover within the request; a per-minute limit does, and Google says when.
      if (/per ?day|daily|per ?month/i.test(text)) return { error, kind: "permanent" };
      const hint = /retry in ([\d.]+)\s*s/i.exec(text) ?? /"retryDelay":\s*"([\d.]+)s"/.exec(text) ?? undefined;
      const header = Number(response.headers.get("retry-after"));
      const seconds = hint ? Number(hint[1]) : Number.isFinite(header) && header > 0 ? header : undefined;
      return { error, kind: "rate-limited", retryAfterMs: seconds === undefined ? undefined : seconds * 1000 };
    }
    return { error, kind: response.status >= 500 ? "transient" : "permanent" };
  }

  async complete({ messages, tools }: { messages: ChatMessage[]; tools: ToolDefinition[] }): Promise<ChatMessage> {
    const body = JSON.stringify({ model: this.config.model, messages: this.prepareMessages(messages), tools, tool_choice: "auto", temperature: this.temperature });
    let result = await this.attempt(body);
    // timeouts and 5xx: retry once; per-minute rate limits (429): wait for the time the provider names, up to two retries
    for (let retries = 0; result.error && (result.kind === "transient" || result.kind === "rate-limited"); retries++) {
      const maxRetries = result.kind === "rate-limited" ? 2 : 1;
      if (retries >= maxRetries) break;
      const wait = this.config.retryDelayMs ?? (result.kind === "rate-limited" ? Math.min((result.retryAfterMs ?? 20_000) + 1_000, 65_000) : 1_500);
      await new Promise((resolve) => setTimeout(resolve, wait));
      result = await this.attempt(body);
    }
    if (result.error || !result.response) {
      const err = result.error ?? new LlmError("LLM request failed");
      if (result.kind === "rate-limited") err.message += " (rate limit: wait a minute, or set LLM_MODEL to a lighter model such as gemini-3.5-flash-lite)";
      else if (err.status === 429) err.message += " (daily quota used up: try again tomorrow, or use another API key or model)";
      throw err;
    }
    const response = result.response;
    const data: any = await response.json();
    const message = data?.choices?.[0]?.message;
    if (!message) throw new LlmError("LLM provider returned no message");
    return {
      role: "assistant",
      content: message.content ?? null,
      ...(message.tool_calls?.length
        // Some OpenAI-compatible providers (e.g. Gemini) can return an empty tool-call id; the id must be unique to pair results.
        ? { tool_calls: (message.tool_calls as ToolCall[]).map((call, i) => ({ ...call, id: call.id || `call_${randomUUID().slice(0, 8)}_${i}`, type: "function" as const })) }
        : {}),
    };
  }
}

export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient | null {
  if (!env.LLM_API_KEY) return null;
  return new OpenAiCompatibleClient({
    apiKey: env.LLM_API_KEY,
    baseUrl: env.LLM_API_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai",
    model: env.LLM_MODEL ?? "gemini-3.5-flash",
  });
}
