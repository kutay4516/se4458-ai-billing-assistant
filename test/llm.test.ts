import { afterEach, describe, expect, it, vi } from "vitest";
import { GEMINI_SKIP_SIGNATURE, OpenAiCompatibleClient, type ChatMessage } from "../src/agent/llm.js";

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";
const history: ChatMessage[] = [
  { role: "user", content: "pay $20" },
  { role: "assistant", content: null, tool_calls: [
    { id: "a", type: "function", function: { name: "query_bill", arguments: "{}" }, extra_content: { google: { thought_signature: "real-signature" } } },
    { id: "b", type: "function", function: { name: "pay_bill", arguments: "{}" } },
  ] },
  { role: "tool", tool_call_id: "a", content: "{}" },
];

function captureBody() {
  let body: any;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
  }));
  return () => body;
}
afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible client", () => {
  it("Gemini: keeps real thought signatures and adds the documented placeholder only where missing", async () => {
    const body = captureBody();
    await new OpenAiCompatibleClient({ apiKey: "k", baseUrl: GEMINI, model: "gemini-3.5-flash" }).complete({ messages: history, tools: [] });
    const calls = body().messages[1].tool_calls;
    expect(calls[0].extra_content.google.thought_signature).toBe("real-signature");
    expect(calls[1].extra_content.google.thought_signature).toBe(GEMINI_SKIP_SIGNATURE);
    expect(history[1].tool_calls![1].extra_content).toBeUndefined(); // caller's history is not mutated
  });

  it("Gemini 3 uses the provider's default temperature; other models get 0.1", async () => {
    let body = captureBody();
    await new OpenAiCompatibleClient({ apiKey: "k", baseUrl: GEMINI, model: "gemini-3.5-flash" }).complete({ messages: history, tools: [] });
    expect("temperature" in body()).toBe(false);
    body = captureBody();
    await new OpenAiCompatibleClient({ apiKey: "k", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }).complete({ messages: history, tools: [] });
    expect(body().temperature).toBe(0.1);
  });

  it("other providers never receive Gemini-specific fields", async () => {
    const body = captureBody();
    await new OpenAiCompatibleClient({ apiKey: "k", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }).complete({ messages: history, tools: [] });
    expect(body().messages[1].tool_calls[1].extra_content).toBeUndefined();
  });

  it("keeps the provider's error text in the thrown error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"model gone"}}', { status: 404 })));
    await expect(new OpenAiCompatibleClient({ apiKey: "k", baseUrl: GEMINI, model: "x" }).complete({ messages: history, tools: [] }))
      .rejects.toThrow(/HTTP 404.*model gone/);
  });
});

describe("OpenAI-compatible client: transient failures", () => {
  const ok = () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
  const client = () => new OpenAiCompatibleClient({ apiKey: "k", baseUrl: GEMINI, model: "gemini-3.5-flash", retryDelayMs: 1 });

  it("retries once after a timeout and then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    const reply = await client().complete({ messages: history, tools: [] });
    expect(reply.content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 or 5xx once, but gives up after the second failure", async () => {
    const fetchMock = vi.fn(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().complete({ messages: history, tools: [] })).rejects.toThrow(/HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent errors such as 401 or 404", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().complete({ messages: history, tools: [] })).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAI-compatible client: rate limits (429)", () => {
  const ok = () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
  const quota = (extra = "Please retry in 0.01s.") => new Response(JSON.stringify([{ error: { code: 429, message: `You exceeded your current quota. ${extra}` } }]), { status: 429 });
  const client = () => new OpenAiCompatibleClient({ apiKey: "k", baseUrl: GEMINI, model: "gemini-3.5-flash", retryDelayMs: 1 });

  it("waits and retries a per-minute limit, up to two retries", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(quota()).mockResolvedValueOnce(quota()).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    expect((await client().complete({ messages: history, tools: [] })).content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after two retries and explains the rate limit", async () => {
    const fetchMock = vi.fn(async () => quota());
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().complete({ messages: history, tools: [] })).rejects.toThrow(/HTTP 429.*rate limit/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not wait for a daily quota", async () => {
    const fetchMock = vi.fn(async () => quota("Quota exceeded for metric: GenerateRequestsPerDayPerProjectPerModel-FreeTier"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().complete({ messages: history, tools: [] })).rejects.toThrow(/HTTP 429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
