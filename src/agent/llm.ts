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
];

export async function runLiveAgent(input: {
  subscriberNo: string;
  question: string;
  month: number;
  year: number;
  apiBase: string;
  policyText: string;
  bearerToken?: string;
}) {
  if (!process.env.LLM_API_KEY) return null;

  const trace: AgentTrace[] = [];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${process.env.LLM_API_KEY}`,
  };

  const executeTool = async (name: string, args: Record<string, any>) => {
    if (name === "search_billing_documentation") {
      const terms = String(args.query).toLowerCase().split(/\W+/).filter((term) => term.length > 3);
      const matches = input.policyText.split("\n## ").filter((chunk) => terms.some((term) => chunk.toLowerCase().includes(term)));
      const result = matches.length ? matches.join("\n\n") : input.policyText;
      trace.push({ tool: name, input: args, result });
      return result;
    }

    const params = new URLSearchParams({ subscriberNo: String(args.subscriberNo), month: String(args.month), year: String(args.year) });
    let path = "/bill";
    let init: RequestInit = {};
    if (name === "query_bill_detailed") path = `/bill/detailed?${params}`;
    else if (name === "calculate_bill") {
      path = "/bill/calculate";
      init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) };
    } else path = `/bill?${params}`;

    const response = await fetch(`${input.apiBase}${path}`, init);
    const result = await response.json();
    trace.push({ tool: name, input: args, result });
    return JSON.stringify(result);
  };

  const messages: any[] = [{
    role: "system",
    content: "You are a mobile billing assistant. Use tools for bill data and policy questions. Never claim to make a write or payment. Account writes require explicit confirmation by the caller.",
  }, {
    role: "user",
    content: JSON.stringify({ subscriberNo: input.subscriberNo, month: input.month, year: input.year, question: input.question }),
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
      return { answer: message.content ?? "No answer returned.", trace, scenario: trace.length > 1 ? "combined" : trace.length === 1 ? "mcp-only" : "rest-only" };
    }

    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}");
      const toolResult = await executeTool(call.function.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content: toolResult });
    }
  }

  throw new Error("LLM_TOOL_LOOP_LIMIT");
}
