import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { searchBillingPolicy } from "./search.js";

const apiBase = process.env.BILLING_API_BASE ?? "http://127.0.0.1:3000/api/v1";
const server = new McpServer({ name: "mobile-provider-billing", version: "1.0.0" });

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBase}${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}

server.tool("search_billing_documentation", "Search the indexed mobile provider billing guide", {
  query: z.string().min(2).describe("Policy, pricing, allowance, or payment question"),
}, async ({ query }) => {
  const guide = await readFile("Mobile_Provider_Billing_Guide.md", "utf8");
  const matches = searchBillingPolicy(guide, query);
  const text = matches.length ? matches.map((match) => `[${match.id}] ${match.text}`).join("\n\n") : "No relevant policy chunk found.";
  return { content: [{ type: "text", text }] };
});

server.tool("calculate_bill", "Calculate a subscriber's bill for a billing month", {
  subscriberNo: z.string().min(1), month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2100),
}, async (args) => {
  const result = await api("/bill/calculate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.tool("query_bill", "Query a subscriber's bill summary", {
  subscriberNo: z.string().min(1), month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2100),
}, async (args) => {
  const params = new URLSearchParams({ subscriberNo: args.subscriberNo, month: String(args.month), year: String(args.year) });
  const result = await api(`/bill?${params}`);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.tool("query_bill_detailed", "Query detailed usage and payment information", {
  subscriberNo: z.string().min(1), month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2100),
}, async (args) => {
  const params = new URLSearchParams({ subscriberNo: args.subscriberNo, month: String(args.month), year: String(args.year) });
  const result = await api(`/bill/detailed?${params}`);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.tool("add_usage", "Add phone or internet usage to a subscriber's bill", {
  subscriberNo: z.string().min(1), month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2100), usageType: z.enum(["Phone", "Internet"]), amount: z.number().positive(),
}, async (args) => {
  const result = await api("/usage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.tool("pay_bill", "Record a simulated bill payment", {
  subscriberNo: z.string().min(1), month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2100), amount: z.number().positive(), transactionId: z.string().min(1), confirmed: z.literal(true),
}, async (args) => {
  const { confirmed: _confirmed, ...payment } = args;
  const result = await api("/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payment) });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
