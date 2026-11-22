import { searchBillingDocumentation } from "./mcpClient.js";
import { scenarioForTrace } from "./scenario.js";

export interface AgentTrace {
  tool: string;
  input: unknown;
  result: unknown;
}

const tools = [
  {
    type: "function" as const,
    function: {
      name: "search_billing_documentation",
      description: "Search the indexed mobile provider billing policy guide",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "query_bill",
      description: "Query a subscriber bill summary through the REST API",
      parameters: { type: "object", properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" } }, required: ["subscriberNo", "month", "year"], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "query_bill_detailed",
      description: "Query detailed bill, usage, and payment data through the REST API",
      parameters: { type: "object", properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" } }, required: ["subscriberNo", "month", "year"], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "calculate_bill",
      description: "Calculate a subscriber bill through the REST API",
      parameters: { type: "object", properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" } }, required: ["subscriberNo", "month", "year"], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "add_usage",
      description: "Add subscriber usage after the caller explicitly confirms the write",
      parameters: { type: "object", properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" }, usageType: { type: "string", enum: ["Phone", "Internet"] }, amount: { type: "number" }, confirmed: { type: "boolean", const: true } }, required: ["subscriberNo", "month", "year", "usageType", "amount", "confirmed"], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "pay_bill",
      description: "Record a simulated payment after the caller explicitly confirms it",
      parameters: { type: "object", properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" }, amount: { type: "number" }, transactionId: { type: "string" }, confirmed: { type: "boolean", const: true } }, required: ["subscriberNo", "month", "year", "amount", "transactionId", "confirmed"], additionalProperties: false },
    },
  },
];

export async function runLiveAgent(input: {
  subscriberNo: string;
  question: string;
  month: number;
  year: number;
  gatewayBase: string;
  bearerToken?: string;
  confirmed?: boolean;
}) {
  if (!process.env.LLM_API_KEY) return null;

  const trace: AgentTrace[] = [];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${process.env.LLM_API_KEY}`,
  };

  const executeTool = async (name: string, args: Record<string, any>) => {
    if (name === "search_billing_documentation") {
      const result = await searchBillingDocumentation(String(args.query));
      trace.push({ tool: name, input: args, result });
      return result;
    }

    if ((name === "pay_bill" || name === "add_usage") && (args.confirmed !== true || input.confirmed !== true)) {
      const result = { error: "CONFIRMATION_REQUIRED" };
      trace.push({ tool: name, input: args, result });
      return JSON.stringify(result);
    }

    const params = new URLSearchParams({ subscriberNo: String(args.subscriberNo), month: String(args.month), year: String(args.year) });
    let path = "/bill";
    let init: RequestInit = { headers: input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {} };
    if (name === "query_bill_detailed") path = `/bill/detailed?${params}`;
    else if (name === "calculate_bill") {
      path = "/bill/calculate";
      init = { method: "POST", headers: { "content-type": "application/json", ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}) }, body: JSON.stringify(args) };
    } else if (name === "add_usage") {
      path = "/usage";
      init = { method: "POST", headers: { "content-type": "application/json", ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}) }, body: JSON.stringify(args) };
    } else if (name === "pay_bill") {
      path = "/pay";
      init = { method: "POST", headers: { "content-type": "application/json", ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}) }, body: JSON.stringify(args) };
    } else path = `/bill?${params}`;

    const response = await fetch(`${input.gatewayBase}${path}`, init);
    const result = await response.json();
    trace.push({ tool: name, input: args, result });
    return JSON.stringify(result);
  };

  const messages: any[] = [{
    role: "system",
    content: "You are a mobile billing assistant. Use tools for bill data and policy questions. Cite returned policy section IDs in answers when relevant. Never claim to make a write or payment unless its tool succeeded. Account writes require explicit confirmation by the caller.",
  }, {
    role: "user",
    content: JSON.stringify({ subscriberNo: input.subscriberNo, month: input.month, year: input.year, question: input.question, confirmed: input.confirmed === true }),
  }];

  for (let turn = 0; turn < 4; turn += 1) {
    const response = await fetch(`${process.env.LLM_API_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: process.env.LLM_MODEL ?? "gpt-4o-mini", messages, tools, tool_choice: "auto" }),
    });
    if (!response.ok) throw new Error(`LLM_REQUEST_FAILED:${response.status}`);
    const data = await response.json();
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("LLM_RESPONSE_MISSING");

    messages.push(message);
    if (!message.tool_calls?.length) {
      return { answer: message.content ?? "No answer returned.", trace, scenario: scenarioForTrace(trace) };
    }

    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}");
      const toolResult = await executeTool(call.function.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content: toolResult });
    }
  }

  throw new Error("LLM_TOOL_LOOP_LIMIT");
}
