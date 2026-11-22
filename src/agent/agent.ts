import { randomUUID } from "node:crypto";
import type { DocsClient, RestClient } from "./clients.js";
import type { ChatMessage, LlmClient, ToolCall } from "./llm.js";
import { SessionStore, type PendingPayment, type Session } from "./sessions.js";
import { TOOLS, TOOL_SOURCE } from "./tools.js";

export interface TraceEntry {
  step: number;
  tool: string;
  via: "MCP" | "REST";
  /** For REST: the gateway route that was called. */
  endpoint?: string;
  input: unknown;
  status?: number;
  result: unknown;
  durationMs: number;
  note?: string;
}

export type Scenario = "mcp-only" | "rest-only" | "combined" | "no-tools";

export interface AgentResult {
  answer: string;
  scenario: Scenario;
  trace: TraceEntry[];
  conversationId: string;
  /** Present when a payment is staged and waiting for the user's explicit confirmation. */
  pendingConfirmation?: { actionId: string; month: number; year: number; amount: number; remainingBalance: number; currency: "USD"; expiresInSeconds: number };
}

export interface AgentDeps {
  llm: LlmClient;
  docs: DocsClient;
  rest: RestClient;
  sessions: SessionStore;
  now?: () => Date;
}

export interface Identity { subscriberNo: string; token: string }

const MAX_TOOL_ROUNDS = 6;
const PENDING_TTL_MS = 5 * 60_000;
/** Strict confirmation words. Only consulted when a payment is already staged; it is a safety gate, not routing. */
const CONFIRM_RE = /^\s*(yes|y|confirm|confirmed|i confirm|yes,? confirm(ed)?|evet|onay(l[ıi]yorum|la)?|evet,? onay(l[ıi]yorum|la))\W*$/i;

export function systemPrompt(today: Date, subscriberNo: string): string {
  const date = today.toISOString().slice(0, 10);
  return [
    "You are the AI Billing Support Assistant of a mobile provider. Help the signed-in subscriber with billing rules, extra data charges, bills, detailed usage and payments.",
    `Today is ${date}. The signed-in subscriber is ${subscriberNo}; their identity is fixed by authentication. Never ask for, accept or use a different subscriber number: if the user asks about someone else's account, refuse politely.`,
    "TOOL USE: decide yourself which tools are needed.",
    "- Rules, prices, allowances, cycles, partial payments, disputes, late payments -> search_billing_documentation (MCP).",
    "- The subscriber's own bill / balance -> query_bill. Usage and charge breakdown -> query_bill_detailed.",
    "- 'Why is my bill higher?' -> query_bill_detailed for the month (and the previous month to compare) AND search_billing_documentation for the pricing rule.",
    "- 'Pay my bill' / 'pay $X' -> pay_bill. It only stages the payment; tell the user the amount and ask them to confirm. Never claim a payment was made unless a tool result says status SUCCESS.",
    "MONTHS: when the user names a month without a year, use the most recent such month that is not in the future relative to today. If the month is missing and cannot be inferred, ask.",
    "ANSWERS: ground every figure in tool results; do not invent numbers. When you use documentation, cite the section reference returned by the tool, e.g. (Source: Mobile_Provider_Billing_Guide.md § 3.2 Additional internet blocks). Amounts are in USD. Reply in the language the user writes in. Be concise.",
  ].join("\n");
}

function parseArgs(call: ToolCall): { args: Record<string, any>; error?: string } {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return { args: parsed && typeof parsed === "object" ? parsed : {} };
  } catch {
    return { args: {}, error: "Tool arguments were not valid JSON" };
  }
}

function isMonthYear(args: Record<string, any>): string | null {
  if (!Number.isInteger(args.month) || args.month < 1 || args.month > 12) return "month must be an integer 1-12";
  if (!Number.isInteger(args.year) || args.year < 2000 || args.year > 2100) return "year must be a four-digit integer";
  return null;
}

export class BillingAgent {
  constructor(private readonly deps: AgentDeps) {}

  async chat(identity: Identity, input: { message: string; conversationId?: string; confirmActionId?: string }): Promise<AgentResult> {
    const conversationId = input.conversationId ?? randomUUID();
    const session = this.deps.sessions.get(identity.subscriberNo, conversationId);
    const trace: TraceEntry[] = [];
    const system: ChatMessage = { role: "system", content: systemPrompt(this.deps.now?.() ?? new Date(), identity.subscriberNo) };
    const messages: ChatMessage[] = [system, ...session.history, { role: "user", content: input.message }];

    // Payment confirmation gate: enforced in code, independently of anything the LLM says.
    const pending = session.pending;
    session.pending = undefined;
    if (pending) {
      const confirmed = input.confirmActionId
        ? input.confirmActionId === pending.actionId
        : CONFIRM_RE.test(input.message);
      if (confirmed && pending.expiresAt >= Date.now()) {
        await this.executeConfirmedPayment(identity, pending, messages, trace);
      } else if (confirmed) {
        messages.push({ role: "user", content: "(System note: the previous payment request expired; no payment was made.)" });
      }
      // Any other message cancels the staged payment (session.pending already cleared).
    }

    const finalMessage = await this.runToolLoop(identity, session, messages, trace);
    const answer = finalMessage.content?.trim() || "I could not produce an answer.";
    this.deps.sessions.remember(session, input.message, answer);

    const sources = new Set(trace.map((t) => t.via));
    const scenario: Scenario = sources.size === 0 ? "no-tools" : sources.size === 2 ? "combined" : sources.has("MCP") ? "mcp-only" : "rest-only";
    const result: AgentResult = { answer, scenario, trace, conversationId };
    const staged = session.pending as PendingPayment | undefined; // may have been set by the pay_bill tool during the loop
    if (staged) {
      const p = staged;
      result.pendingConfirmation = { actionId: p.actionId, month: p.month, year: p.year, amount: p.amount, remainingBalance: p.remainingBalance, currency: "USD", expiresInSeconds: Math.round((p.expiresAt - Date.now()) / 1000) };
    }
    return result;
  }

  private async runToolLoop(identity: Identity, session: Session, messages: ChatMessage[], trace: TraceEntry[]): Promise<ChatMessage> {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const reply = await this.deps.llm.complete({ messages, tools: TOOLS });
      messages.push(reply);
      if (!reply.tool_calls?.length) return reply;
      for (const call of reply.tool_calls) {
        const content = await this.executeTool(identity, session, call, trace);
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }
    return { role: "assistant", content: "I could not finish this request within the tool-call limit. Please rephrase or narrow the question." };
  }

  /** Executes one LLM-selected tool call and returns the JSON string handed back to the LLM. */
  private async executeTool(identity: Identity, session: Session, call: ToolCall, trace: TraceEntry[]): Promise<string> {
    const name = call.function.name;
    const via = TOOL_SOURCE[name];
    const started = Date.now();
    const { args, error } = parseArgs(call);
    const record = (entry: Omit<TraceEntry, "step" | "durationMs" | "via" | "tool">) => {
      trace.push({ step: trace.length + 1, tool: name, via: via ?? "REST", durationMs: Date.now() - started, ...entry });
    };

    if (!via) { const result = { error: `Unknown tool ${name}` }; record({ input: args, result }); return JSON.stringify(result); }
    if (error) { const result = { error }; record({ input: call.function.arguments, result }); return JSON.stringify(result); }

    try {
      if (name === "search_billing_documentation") {
        if (typeof args.query !== "string" || args.query.trim().length < 2) {
          const result = { error: "query must be a non-empty string" };
          record({ input: args, result });
          return JSON.stringify(result);
        }
        const result = await this.deps.docs.search(args.query);
        record({ input: { query: args.query }, result });
        return JSON.stringify(result);
      }

      const problem = isMonthYear(args);
      if (problem) { const result = { error: problem }; record({ input: args, result }); return JSON.stringify(result); }
      // Identity comes from the verified JWT. Any subscriberNo the model supplied is discarded.
      const ignoredIdentity = args.subscriberNo !== undefined && String(args.subscriberNo) !== identity.subscriberNo;
      const base = { subscriberNo: identity.subscriberNo, month: args.month as number, year: args.year as number };

      if (name === "query_bill") {
        const res = await this.deps.rest.call("GET", "/api/v1/bill", { token: identity.token, query: base });
        record({ input: base, endpoint: "GET /api/v1/bill", status: res.status, result: res.body, ...(ignoredIdentity ? { note: "model-supplied subscriberNo ignored; JWT identity used" } : {}) });
        return JSON.stringify({ httpStatus: res.status, ...asObject(res.body) });
      }

      if (name === "query_bill_detailed") {
        const query = { ...base, ...(Number.isInteger(args.page) ? { page: args.page } : {}), ...(Number.isInteger(args.pageSize) ? { pageSize: args.pageSize } : {}) };
        const res = await this.deps.rest.call("GET", "/api/v1/bill/detailed", { token: identity.token, query });
        record({ input: query, endpoint: "GET /api/v1/bill/detailed", status: res.status, result: res.body, ...(ignoredIdentity ? { note: "model-supplied subscriberNo ignored; JWT identity used" } : {}) });
        return JSON.stringify({ httpStatus: res.status, ...asObject(res.body) });
      }

      // pay_bill: stage only. The payment API is called after explicit user confirmation (executeConfirmedPayment).
      const check = await this.deps.rest.call("GET", "/api/v1/bill", { token: identity.token, query: base });
      const bill = asObject(check.body) as { remainingBalance?: number; total?: number; status?: string };
      if (check.status !== 200 || typeof bill.remainingBalance !== "number") {
        const result = { status: "NOT_STAGED", httpStatus: check.status, ...asObject(check.body) };
        record({ input: { ...args, ...base }, endpoint: "GET /api/v1/bill (pre-check)", status: check.status, result });
        return JSON.stringify(result);
      }
      const amount = args.amount === undefined ? bill.remainingBalance : Number(args.amount);
      const invalid = !(amount > 0) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6 || amount > bill.remainingBalance + 1e-9;
      if (invalid) {
        const result = { status: "NOT_STAGED", reason: bill.remainingBalance === 0 ? "The bill has no remaining balance." : `Amount must be > 0, have at most 2 decimals and not exceed the remaining balance of ${bill.remainingBalance}.`, remainingBalance: bill.remainingBalance };
        record({ input: { ...args, ...base }, endpoint: "GET /api/v1/bill (pre-check)", status: check.status, result });
        return JSON.stringify(result);
      }
      const pending: PendingPayment = {
        actionId: randomUUID(), month: base.month, year: base.year, amount, remainingBalance: bill.remainingBalance,
        transactionId: `AGENT-${randomUUID()}`, expiresAt: Date.now() + PENDING_TTL_MS,
      };
      session.pending = pending;
      const result = {
        status: "CONFIRMATION_REQUIRED",
        message: "Payment NOT executed. Ask the user to explicitly confirm (e.g. reply 'yes, confirm') before it is submitted.",
        payment: { month: pending.month, year: pending.year, amount: pending.amount, currency: "USD", remainingBalanceBefore: pending.remainingBalance },
      };
      record({ input: { ...args, ...base }, endpoint: "GET /api/v1/bill (pre-check) — Pay Bill NOT called yet", status: check.status, result, note: "awaiting explicit user confirmation" });
      return JSON.stringify(result);
    } catch (err: any) {
      const result = { error: `Tool ${name} failed: ${err?.message ?? err}` };
      record({ input: args, result });
      return JSON.stringify(result);
    }
  }

  /** Runs only after the user explicitly confirmed a staged payment. Result is returned to the LLM as a tool message. */
  private async executeConfirmedPayment(identity: Identity, pending: PendingPayment, messages: ChatMessage[], trace: TraceEntry[]) {
    const started = Date.now();
    const body = { subscriberNo: identity.subscriberNo, month: pending.month, year: pending.year, amount: pending.amount, transactionId: pending.transactionId };
    let status = 0;
    let result: unknown;
    try {
      const res = await this.deps.rest.call("POST", "/api/v1/pay", { token: identity.token, body });
      status = res.status;
      result = { httpStatus: res.status, ...asObject(res.body) };
    } catch (err: any) {
      result = { error: `Payment call failed: ${err?.message ?? err}` };
    }
    trace.push({ step: trace.length + 1, tool: "pay_bill", via: "REST", endpoint: "POST /api/v1/pay", input: body, status, result, durationMs: Date.now() - started, note: "executed after explicit user confirmation" });
    const callId = `call_confirmed_${pending.actionId.slice(0, 8)}`;
    messages.push(
      { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "pay_bill", arguments: JSON.stringify({ month: pending.month, year: pending.year, amount: pending.amount }) } }] },
      { role: "tool", tool_call_id: callId, content: JSON.stringify(result) },
    );
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { raw: value };
}
