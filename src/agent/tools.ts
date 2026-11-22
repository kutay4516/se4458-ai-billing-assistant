import type { ToolDefinition } from "./llm.js";

const monthYear = {
  month: { type: "integer", minimum: 1, maximum: 12, description: "Billing month number (1-12)" },
  year: { type: "integer", minimum: 2000, maximum: 2100, description: "Four-digit billing year" },
};

/** Schemas stay within the OpenAPI subset every provider accepts (Gemini rejects e.g. additionalProperties / exclusiveMinimum). */
/**
 * Tools offered to the LLM. Note: none takes a subscriber number. The agent injects the identity from the
 * authenticated JWT, so a subscriber number typed in a prompt can never select another person's data.
 */
export const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_billing_documentation",
      description: "MCP tool. Search the indexed Mobile Provider Billing Guide for rules, pricing, allowances, billing cycles, partial payments, disputes and late payments. Returns excerpts with section references. Use for any policy / 'how much does X cost' / 'how does Y work' question.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Search query in English" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "query_bill",
      description: "REST (Query Bill API). Get the signed-in subscriber's bill total, paid amount, remaining balance and status for one month.",
      parameters: { type: "object", properties: { ...monthYear }, required: ["month", "year"] },
    },
  },
  {
    type: "function",
    function: {
      name: "query_bill_detailed",
      description: "REST (Query Bill Detailed API). Get the signed-in subscriber's detailed bill for one month: phone minutes, internet MB/GB, charge breakdown, usage records (paged) and payments. Use to explain WHY a bill is high or to compare months (call once per month).",
      parameters: {
        type: "object",
        properties: { ...monthYear, page: { type: "integer", minimum: 1 }, pageSize: { type: "integer", minimum: 1, maximum: 100 } },
        required: ["month", "year"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pay_bill",
      description: "REST (Pay Bill API). Request a payment of the signed-in subscriber's bill. This only STAGES the payment: the user must then explicitly confirm before any money movement is recorded. Omit amount to pay the full remaining balance.",
      parameters: { type: "object", properties: { ...monthYear, amount: { type: "number", minimum: 0.01, description: "USD amount; omit for the full remaining balance" } }, required: ["month", "year"] },
    },
  },
];

export const TOOL_SOURCE: Record<string, "MCP" | "REST"> = {
  search_billing_documentation: "MCP",
  query_bill: "REST",
  query_bill_detailed: "REST",
  pay_bill: "REST",
};
