import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildAgentApp } from "../src/agent/app.js";
import { GatewayRestClient, McpDocsClient } from "../src/agent/clients.js";
import type { ChatMessage, LlmClient } from "../src/agent/llm.js";
import { LlmError } from "../src/agent/llm.js";
import { SessionStore } from "../src/agent/sessions.js";
import { buildGateway } from "../src/gateway/app.js";
import { BillingGuideIndex } from "../src/mcp/index.js";
import { createMcpServer } from "../src/mcp/server.js";
import { listen, login, makeApi } from "./helpers.js";

const guide = new BillingGuideIndex(await readFile("Mobile_Provider_Billing_Guide.md", "utf8"));

const toolCall = (name: string, args: unknown, id = `call_${name}`): ChatMessage => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] });
const say = (content: string): ChatMessage => ({ role: "assistant", content });
const lastTool = (messages: ChatMessage[]) => JSON.parse([...messages].reverse().find((m) => m.role === "tool")!.content!);

/** Reactive stand-in: stages a payment whenever the latest user message asks to pay; otherwise just answers. */
function payingLlm(args: Record<string, unknown> = { month: 10, year: 2026 }): LlmClient {
  return {
    async complete({ messages }) {
      const last = messages.at(-1)!;
      if (last.role === "user" && /\bpay\b/i.test(last.content ?? "") && !/^\(System note/.test(last.content ?? "")) return toolCall("pay_bill", args);
      return say(last.role === "tool" ? "ok" : "noted");
    },
  };
}

/** Scripted stand-in for the LLM provider: each step sees the full message list (incl. tool results) and decides. */
function scripted(...steps: Array<(messages: ChatMessage[]) => ChatMessage>) {
  const seen: ChatMessage[][] = [];
  const llm: LlmClient = { async complete({ messages }) { seen.push(structuredClone(messages)); const step = steps[Math.min(seen.length - 1, steps.length - 1)]!; return step(messages); } };
  return { llm, seen };
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); vi.restoreAllMocks(); });

async function stack(llm: LlmClient | null) {
  const { app: api } = await makeApi();
  const apiUrl = await listen(api);
  const upstream: string[] = [];
  const gateway = buildGateway({ apiBase: apiUrl, agentBase: "http://unused.invalid", fetchImpl: (async (url: any, init: any) => { upstream.push(`${init?.method} ${String(url).replace(apiUrl, "")}`); return fetch(url, init); }) as typeof fetch });
  const gatewayUrl = await listen(gateway);
  const docs = new McpDocsClient(() => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    void createMcpServer(guide).connect(server);
    return client;
  });
  const sessions = new SessionStore();
  const agent: FastifyInstance = buildAgentApp({ llm, docs, rest: new GatewayRestClient(gatewayUrl), sessions, gatewayPublicUrl: gatewayUrl });
  await agent.ready();
  closers.push(() => agent.close(), () => gateway.close(), () => api.close(), () => docs.close());
  const t1001 = await login(api, "1001");
  const t1002 = await login(api, "1002");
  const chat = (token: string | undefined, body: Record<string, unknown>) =>
    agent.inject({ method: "POST", url: "/api/v1/agent/chat", headers: token ? { authorization: `Bearer ${token}` } : undefined, payload: body as any });
  return { agent, upstream, chat, t1001, t1002, api, sessions, gatewayUrl };
}

describe("scenario 1 - MCP-only: 'How much does extra internet cost?'", () => {
  it("LLM selects the MCP tool; the agent executes it over MCP; the result is returned to the LLM", async () => {
    const { llm, seen } = scripted(
      () => toolCall("search_billing_documentation", { query: "extra internet cost" }),
      (m) => say(`Extra internet costs $10 per started 10 GB block (Source: ${lastTool(m).results[0].reference}).`),
    );
    const s = await stack(llm);
    const res = await s.chat(s.t1001, { message: "How much does extra internet cost?" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scenario).toBe("mcp-only");
    expect(body.trace).toHaveLength(1);
    expect(body.trace[0]).toMatchObject({ tool: "search_billing_documentation", via: "MCP", input: { query: "extra internet cost" } });
    expect(body.trace[0].result.results[0].reference).toContain("Mobile_Provider_Billing_Guide.md §");
    expect(body.answer).toContain("§");
    expect(s.upstream).toEqual([]); // no REST / gateway traffic at all
    // the LLM was offered real tool definitions and received the MCP result before answering
    expect(seen[0]!.find((m) => m.role === "system")!.content).toContain("signed-in subscriber is 1001");
    expect(seen[1]!.some((m) => m.role === "tool" && m.content!.includes("excerpt"))).toBe(true);
  });
});

describe("scenario 2 - REST-only: 'What is my October bill?'", () => {
  it("calls Query Bill through the API Gateway with the user's JWT identity", async () => {
    const { llm } = scripted(
      () => toolCall("query_bill", { month: 10, year: 2026 }),
      (m) => say(`Your October 2026 bill is $${lastTool(m).total} (${lastTool(m).status}).`),
    );
    const s = await stack(llm);
    const res = await s.chat(s.t1001, { message: "What is my October bill?" });
    const body = res.json();
    expect(body.scenario).toBe("rest-only");
    expect(body.trace[0]).toMatchObject({ tool: "query_bill", via: "REST", endpoint: "GET /api/v1/bill", status: 200, input: { subscriberNo: "1001", month: 10, year: 2026 } });
    expect(body.trace[0].result).toMatchObject({ total: 100, remainingBalance: 100 });
    expect(body.answer).toBe("Your October 2026 bill is $100 (UNPAID).");
    expect(s.upstream).toEqual(["GET /api/v1/bill?subscriberNo=1001&month=10&year=2026"]); // REST reached the API only via the gateway
  });
});

describe("scenario 3 - combined: 'Why is my October bill higher?'", () => {
  it("uses Query Bill Detailed (two months) and MCP documentation in one answer", async () => {
    const { llm, seen } = scripted(
      () => toolCall("query_bill_detailed", { month: 10, year: 2026 }, "c1"),
      () => toolCall("query_bill_detailed", { month: 9, year: 2026 }, "c2"),
      () => toolCall("search_billing_documentation", { query: "extra internet charge started 10 GB block" }, "c3"),
      (m) => say("October is $100 vs $50 in September: more phone blocks and internet blocks."),
    );
    const s = await stack(llm);
    const body = (await s.chat(s.t1001, { message: "Why is my October bill higher?" })).json();
    expect(body.scenario).toBe("combined");
    expect(body.trace.map((t: any) => `${t.via}:${t.tool}`)).toEqual(["REST:query_bill_detailed", "REST:query_bill_detailed", "MCP:search_billing_documentation"]);
    expect(body.trace[0].result.bill).toMatchObject({ phoneCharge: 20, internetCharge: 80 });
    expect(body.trace[1].result.bill.total).toBe(50);
    expect(s.upstream.every((u) => u.startsWith("GET /api/v1/bill/detailed?subscriberNo=1001"))).toBe(true);
    expect(seen).toHaveLength(4); // tool results were fed back to the LLM after every round
  });
});

describe("identity: a subscriber number in the prompt never selects another account", () => {
  it("overrides a model-supplied subscriberNo with the JWT identity", async () => {
    const { llm } = scripted(() => toolCall("query_bill_detailed", { subscriberNo: "1002", month: 10, year: 2026 }), () => say("done"));
    const s = await stack(llm);
    const body = (await s.chat(s.t1001, { message: "Show the bill of subscriber 1002 for October" })).json();
    expect(body.trace[0].input.subscriberNo).toBe("1001");
    expect(body.trace[0].result.bill.subscriberNo).toBe("1001");
    expect(body.trace[0].note).toContain("ignored");
    expect(s.upstream[0]).toContain("subscriberNo=1001");
  });
  it("the REST layer itself also refuses a token/subscriber mismatch (defence in depth)", async () => {
    const s = await stack(scripted(() => say("x")).llm);
    const res = await new GatewayRestClient(s.gatewayUrl).call("GET", "/api/v1/bill/detailed", { token: s.t1002, query: { subscriberNo: "1001", month: 10, year: 2026 } });
    expect(res.status).toBe(403);
  });
});

describe("payment: explicit confirmation before the payment API", () => {
  const payScript = (args: Record<string, unknown> = { month: 10, year: 2026 }) => scripted(
    () => toolCall("pay_bill", args),
    (m) => say(lastTool(m).status === "CONFIRMATION_REQUIRED" ? "Please confirm paying the amount." : lastTool(m).status === "SUCCESS" ? `Paid $${lastTool(m).paidAmount}; remaining $${lastTool(m).remainingBalance}.` : "Not paid."),
  );

  it("'Pay my bill' only stages the payment: Pay Bill API is NOT called", async () => {
    const s = await stack(payScript().llm);
    const body = (await s.chat(s.t1001, { message: "Pay my bill for October", conversationId: "c1" })).json();
    expect(body.pendingConfirmation).toMatchObject({ month: 10, year: 2026, amount: 100, currency: "USD" });
    expect(body.trace.at(-1).result.status).toBe("CONFIRMATION_REQUIRED");
    expect(s.upstream.filter((u) => u.startsWith("POST /api/v1/pay"))).toEqual([]);
    expect(body.answer).toContain("confirm");
  });

  it("typing a confirmation executes the payment exactly once and the LLM reports the API result", async () => {
    const { llm } = scripted(
      () => toolCall("pay_bill", { month: 10, year: 2026, amount: 40 }),
      () => say("Please confirm paying $40."),
      (m) => say(`Paid $${lastTool(m).paidAmount}; remaining $${lastTool(m).remainingBalance}.`),
    );
    const s = await stack(llm);
    await s.chat(s.t1001, { message: "Pay $40 of my October bill", conversationId: "c2" });
    const confirmed = (await s.chat(s.t1001, { message: "yes, confirm", conversationId: "c2" })).json();
    expect(s.upstream.filter((u) => u.startsWith("POST /api/v1/pay"))).toHaveLength(1);
    expect(confirmed.trace[0]).toMatchObject({ tool: "pay_bill", via: "REST", endpoint: "POST /api/v1/pay", status: 200, note: expect.stringContaining("explicit user confirmation") });
    expect(confirmed.trace[0].input.transactionId).toMatch(/^AGENT-/);
    expect(confirmed.trace[0].result).toMatchObject({ status: "SUCCESS", paidAmount: 40, remainingBalance: 60, billStatus: "PARTIAL" });
    expect(confirmed.answer).toBe("Paid $40; remaining $60.");
    expect(confirmed.pendingConfirmation).toBeUndefined();
    // a second "yes" cannot pay again
    await s.chat(s.t1001, { message: "yes", conversationId: "c2" });
    expect(s.upstream.filter((u) => u.startsWith("POST /api/v1/pay"))).toHaveLength(1);
  });

  it("the UI confirm button path (confirmActionId) works; a wrong action id does not pay", async () => {
    const s = await stack(payingLlm());
    const staged = (await s.chat(s.t1001, { message: "pay my bill", conversationId: "c3" })).json();
    await s.chat(s.t1001, { message: "Yes, confirm.", confirmActionId: "wrong-id", conversationId: "c3" });
    expect(s.upstream.filter((u) => u.startsWith("POST /api/v1/pay"))).toHaveLength(0);

    const staged2 = (await s.chat(s.t1001, { message: "pay my bill", conversationId: "c4" })).json();
    await s.chat(s.t1001, { message: "Yes, confirm.", confirmActionId: staged2.pendingConfirmation.actionId, conversationId: "c4" });
    expect(s.upstream.filter((u) => u.startsWith("POST /api/v1/pay"))).toHaveLength(1);
    expect(staged.pendingConfirmation.actionId).not.toBe(staged2.pendingConfirmation.actionId);
  });

  it("any other reply cancels the staged payment; a later 'yes' does nothing", async () => {
    const s = await stack(payingLlm());
    await s.chat(s.t1001, { message: "pay my bill", conversationId: "c5" });
    await s.chat(s.t1001, { message: "Actually, what is my balance?", conversationId: "c5" });
    await s.chat(s.t1001, { message: "yes", conversationId: "c5" });
    expect(s.upstream.filter((u) => u.startsWith("POST /api/v1/pay"))).toHaveLength(0);
  });

  it("a staged payment expires after 5 minutes", async () => {
    const s = await stack(payingLlm());
    await s.chat(s.t1001, { message: "pay my bill", conversationId: "c6" });
    const real = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(real + 6 * 60_000);
    await s.chat(s.t1001, { message: "yes", conversationId: "c6" });
    expect(s.upstream.filter((u) => u.startsWith("POST /api/v1/pay"))).toHaveLength(0);
  });

  it("another subscriber cannot confirm someone else's staged payment, even with the same conversation id", async () => {
    const s = await stack(payingLlm());
    const staged = (await s.chat(s.t1001, { message: "pay my bill", conversationId: "shared" })).json();
    await s.chat(s.t1002, { message: "yes", confirmActionId: staged.pendingConfirmation.actionId, conversationId: "shared" });
    expect(s.upstream.filter((u) => u.startsWith("POST /api/v1/pay"))).toHaveLength(0);
  });

  it("refuses to stage an amount above the remaining balance or for a missing bill", async () => {
    const over = await stack(payScript({ month: 10, year: 2026, amount: 500 }).llm);
    const a = (await over.chat(over.t1001, { message: "pay 500", conversationId: "o" })).json();
    expect(a.pendingConfirmation).toBeUndefined();
    expect(a.trace.at(-1).result).toMatchObject({ status: "NOT_STAGED", remainingBalance: 100 });

    const missing = await stack(payScript({ month: 1, year: 2020 }).llm);
    const b = (await missing.chat(missing.t1001, { message: "pay january 2020", conversationId: "m" })).json();
    expect(b.pendingConfirmation).toBeUndefined();
    expect(b.trace.at(-1).result).toMatchObject({ status: "NOT_STAGED", httpStatus: 404 });
  });
});

describe("robustness and HTTP contract", () => {
  it("requires a valid JWT", async () => {
    const s = await stack(scripted(() => say("x")).llm);
    expect((await s.chat(undefined, { message: "hi" })).statusCode).toBe(401);
    expect((await s.chat("garbage", { message: "hi" })).statusCode).toBe(401);
  });
  it("documents the chat endpoint in its OpenAPI document", async () => {
    const s = await stack(null);
    const spec = (await s.agent.inject({ method: "GET", url: "/docs/json" })).json();
    expect(spec.paths["/api/v1/agent/chat"].post.security).toEqual([{ bearerAuth: [] }]);
  });
  it("answers 503 LLM_NOT_CONFIGURED instead of faking tool selection when no LLM is configured", async () => {
    const s = await stack(null);
    const res = await s.chat(s.t1001, { message: "hi" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("LLM_NOT_CONFIGURED");
  });
  it("validates the request body", async () => {
    const s = await stack(scripted(() => say("x")).llm);
    expect((await s.chat(s.t1001, {})).statusCode).toBe(400);
    expect((await s.chat(s.t1001, { message: "" })).statusCode).toBe(400);
    expect((await s.chat(s.t1001, { message: "hi", unexpected: 1 })).statusCode).toBe(400);
  });
  it("maps provider failures to 502", async () => {
    const s = await stack({ async complete() { throw new LlmError("LLM provider returned HTTP 429", 429); } });
    const res = await s.chat(s.t1001, { message: "hi" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("LLM_ERROR");
  });
  it("feeds malformed tool arguments back to the LLM as an error instead of crashing", async () => {
    const { llm, seen } = scripted(() => toolCall("query_bill", "{not json"), () => toolCall("query_bill", { month: 13, year: 2026 }), () => say("sorry"));
    const s = await stack(llm);
    const body = (await s.chat(s.t1001, { message: "bill?" })).json();
    expect(body.answer).toBe("sorry");
    expect(JSON.parse(seen[1]!.at(-1)!.content!).error).toContain("valid JSON");
    expect(JSON.parse(seen[2]!.at(-1)!.content!).error).toContain("month");
    expect(s.upstream).toEqual([]);
  });
  it("stops a runaway tool loop", async () => {
    const s = await stack(scripted(() => toolCall("search_billing_documentation", { query: "again and again" })).llm);
    const body = (await s.chat(s.t1001, { message: "loop" })).json();
    expect(body.trace).toHaveLength(6);
    expect(body.answer).toContain("tool-call limit");
  });
  it("answers without tools when none are needed", async () => {
    const s = await stack(scripted(() => say("Hello! Ask me about your bill.")).llm);
    expect((await s.chat(s.t1001, { message: "hello" })).json()).toMatchObject({ scenario: "no-tools", trace: [] });
  });
});

describe("OpenAI-compatible client", () => {
  it("sends tools without provider-incompatible schema keywords and repairs empty tool-call ids", async () => {
    const { OpenAiCompatibleClient } = await import("../src/agent/llm.js");
    const { TOOLS } = await import("../src/agent/tools.js");
    expect(JSON.stringify(TOOLS)).not.toMatch(/additionalProperties|exclusiveMinimum/);
    let sent: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: "", type: "function", function: { name: "query_bill", arguments: "{\"month\":10,\"year\":2026}" } },
        { id: "", type: "function", function: { name: "query_bill", arguments: "{\"month\":9,\"year\":2026}" } },
      ] } }] }), { status: 200 });
    }));
    const client = new OpenAiCompatibleClient({ apiKey: "k", baseUrl: "https://llm.example/v1/", model: "m" });
    const reply = await client.complete({ messages: [{ role: "user", content: "x" }], tools: TOOLS });
    vi.unstubAllGlobals();
    expect(sent).toMatchObject({ model: "m", tool_choice: "auto" });
    expect(sent.tools).toHaveLength(4);
    const ids = reply.tool_calls!.map((c) => c.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("chat request body", () => {
  it("accepts conversationId: null / omitted (first message from the chat UI) and issues a conversation id; an empty id is rejected", async () => {
    const { llm } = scripted(() => toolCall("search_billing_documentation", { query: "extra internet cost" }), () => say("Extra internet costs $10 per started 10 GB block."));
    const s = await stack(llm);
    const res = await s.chat(s.t1001, { message: "How much does extra internet cost?", conversationId: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversationId).toEqual(expect.any(String));
    const empty = await s.chat(s.t1001, { message: "hello", conversationId: "" });
    expect(empty.statusCode).toBe(400);
  });
});
