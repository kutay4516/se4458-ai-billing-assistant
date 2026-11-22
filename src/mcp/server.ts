import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { indexBillingPolicy, searchIndexedBillingPolicy } from "./search.js";

export async function buildMcpServer() {
const gatewayBase = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:3001/gateway/v1";
const server = new McpServer({ name: "mobile-provider-billing", version: "1.0.0" });
const policyIndex = indexBillingPolicy(await readFile("Mobile_Provider_Billing_Guide.md", "utf8"));

async function authenticatedApi(path: string, init: RequestInit = {}) {
  const login = await fetch(`${gatewayBase}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscriberNo: process.env.DEMO_SUBSCRIBER_NO ?? "1001",
      username: process.env.DEMO_USERNAME ?? "subscriber1001",
      password: process.env.DEMO_PASSWORD ?? "change-me",
    }),
  });
  const loginBody = await login.json();
  if (!login.ok || !loginBody.token) throw new Error("INVALID_MCP_CREDENTIALS");

  const response = await fetch(`${gatewayBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${loginBody.token}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${gatewayBase}${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}

server.tool("search_billing_documentation", "Search the indexed mobile provider billing guide", {
  query: z.string().min(2).describe("Policy, pricing, allowance, or payment question"),
}, async ({ query }) => {
  const matches = searchIndexedBillingPolicy(policyIndex, query);
  const text = matches.length ? matches.map((match) => `[${match.id}] ${match.text}`).join("\n\n") : "No relevant policy section found.";
  return { content: [{ type: "text", text }] };
});

server.tool("calculate_bill", "Calculate a subscriber's bill for a billing month", {
  subscriberNo: z.string().min(1), month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2100),
}, async (args) => {
  const result = await authenticatedApi("/bill/calculate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
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
  const result = await authenticatedApi(`/bill/detailed?${params}`);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.tool("add_usage", "Add phone or internet usage to a subscriber's bill", {
  subscriberNo: z.string().min(1), month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2100), usageType: z.enum(["Phone", "Internet"]), amount: z.number().positive(), confirmed: z.literal(true),
}, async (args) => {
  const result = await authenticatedApi("/usage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

server.tool("pay_bill", "Record a simulated bill payment", {
  subscriberNo: z.string().min(1), month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2100), amount: z.number().positive(), transactionId: z.string().min(1), confirmed: z.literal(true),
}, async (args) => {
  const result = await authenticatedApi("/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

return server;
}

if (["server.js", "server.ts"].includes(basename(process.argv[1] ?? ""))) {
  const server = await buildMcpServer();
  await server.connect(new StdioServerTransport());
}
