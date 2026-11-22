/**
 * End-to-end demo / evidence generator. Run against a running stack (`npm run dev` or docker compose):
 *   GATEWAY_URL=http://localhost:3001 MCP_URL=http://localhost:3002/mcp DEMO_PASSWORD=... npm run e2e
 * Prints a markdown transcript: protected gateway route, error response, three MCP retrieval queries,
 * the three agent scenarios with tool traces, and a confirmed simulated payment.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const gateway = (process.env.GATEWAY_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const mcpUrl = process.env.MCP_URL ?? "http://127.0.0.1:3002/mcp";
const password = process.env.DEMO_PASSWORD ?? "demo-password";
const subscriberNo = process.env.DEMO_SUBSCRIBER ?? "1001";
const month = Number(process.env.DEMO_MONTH ?? 10);
const year = Number(process.env.DEMO_YEAR ?? 2026);

const out: string[] = [];
const h = (text: string) => out.push(`\n## ${text}\n`);
const block = (value: unknown, lang = "json") => out.push("```" + lang + "\n" + (typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n```");
const trunc = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "string" && x.length > 300 ? x.slice(0, 300) + "…" : x)));

async function http(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${gateway}${path}`, { method, headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body ? { "content-type": "application/json" } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let body: unknown = text; try { body = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, headers: Object.fromEntries(res.headers), body };
}

out.push(`# Demo transcript\n\nGateway: \`${gateway}\` · MCP: \`${mcpUrl}\` · generated ${new Date().toISOString()}`);

h("1. API Gateway: public route, protected route, error response");
const pub = await http("GET", `/api/v1/bill?subscriberNo=${subscriberNo}&month=${month}&year=${year}`);
out.push(`**Public route** \`GET /api/v1/bill\` (no token) -> \`${pub.status}\` (route \`${pub.headers["x-gateway-route"]}\`)`); block(pub.body);
const denied = await http("GET", `/api/v1/bill/detailed?subscriberNo=${subscriberNo}&month=${month}&year=${year}`);
out.push(`**Protected route without token** \`GET /api/v1/bill/detailed\` -> \`${denied.status}\` (error response)`); block(denied.body);
const login = await http("POST", "/api/v1/auth/token", { body: { subscriberNo, password } });
if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
const token = (login.body as any).token as string;
out.push(`**Login** \`POST /api/v1/auth/token\` -> \`${login.status}\` (JWT issued, expires in ${(login.body as any).expiresIn}s)`);
const allowed = await http("GET", `/api/v1/bill/detailed?subscriberNo=${subscriberNo}&month=${month}&year=${year}&page=1&pageSize=5`, { token });
out.push(`**Protected route with JWT** -> \`${allowed.status}\``); block(trunc(allowed.body));
const other = subscriberNo === "1001" ? "1002" : "1001";
const forbidden = await http("GET", `/api/v1/bill/detailed?subscriberNo=${other}&month=${month}&year=${year}`, { token });
out.push(`**Authorization: subscriber ${subscriberNo}'s token asking for ${other}'s detailed bill** -> \`${forbidden.status}\``); block(forbidden.body);
const routes = await http("GET", "/gateway/routes");
out.push("**Route mapping** `GET /gateway/routes`"); block((routes.body as any).routes.map((r: any) => `${r.method} ${r.publicPath} -> ${r.upstream}${r.upstreamPath} [auth:${r.auth}, ${r.rateLimit.max}/${r.rateLimit.timeWindow}]`), "text");

h("2. MCP retrieval tests (direct MCP client -> MCP server, not through the gateway)");
const mcp = new Client({ name: "e2e-demo", version: "1.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
const tools = await mcp.listTools();
out.push(`Tools exposed by the MCP server: \`${tools.tools.map((t) => t.name).join(", ")}\``);
for (const query of ["How much does extra internet cost?", "Can I pay my bill in parts? partial payment", "What happens if I pay late?"]) {
  const r: any = await mcp.callTool({ name: "search_billing_documentation", arguments: { query } });
  const payload = JSON.parse(r.content[0].text);
  out.push(`**Query:** \`${query}\``);
  block(trunc({ resultCount: payload.resultCount, top: payload.results.slice(0, 2).map((x: any) => ({ reference: x.reference, score: x.score, excerpt: x.excerpt })) }));
}
await mcp.close();

h("3. Agent scenarios (LLM tool calling; tool trace = tool, input, result)");
let conversationId: string | undefined;
// a short pause between agent requests keeps free-tier LLM quotas (requests/tokens per minute) from being hit back to back
const pauseMs = Number(process.env.E2E_PAUSE_MS ?? 4000);
async function ask(label: string, message: string, extra: Record<string, unknown> = {}) {
  await new Promise((resolve) => setTimeout(resolve, pauseMs));
  const res = await http("POST", "/api/v1/agent/chat", { token, body: { message, ...(conversationId ? { conversationId } : {}), ...extra } });
  out.push(`### ${label}\n\n**User:** ${message}`);
  if (res.status !== 200) { block(res.body); return null; }
  const body = res.body as any;
  conversationId = body.conversationId;
  out.push(`**Scenario:** \`${body.scenario}\``);
  block(trunc(body.trace.map((t: any) => ({ step: t.step, tool: t.tool, via: t.via, endpoint: t.endpoint, status: t.status, input: t.input, result: t.result, note: t.note }))));
  out.push(`**Assistant:** ${body.answer}`);
  return body;
}
await ask("3a. MCP-only", "How much does extra internet cost?");
conversationId = undefined;
await ask("3b. REST API-only", "What is my October 2026 bill?");
conversationId = undefined;
await ask("3c. Combined MCP + REST", "Why is my October 2026 bill higher than September?");

h("4. Payment with explicit confirmation");
conversationId = undefined;
const before = (await http("GET", `/api/v1/bill?subscriberNo=${subscriberNo}&month=${month}&year=${year}`)).body as any;
out.push(`Balance before: remaining **$${before.remainingBalance}** (status ${before.status})`);
const staged = await ask("4a. Request (payment staged, Pay Bill API NOT called)", "Pay $20 of my October 2026 bill");
if (staged?.pendingConfirmation) {
  const confirmed = await ask("4b. Explicit confirmation (Pay Bill API called now)", "Yes, confirm.", { confirmActionId: staged.pendingConfirmation.actionId });
  void confirmed;
}
const after = (await http("GET", `/api/v1/bill?subscriberNo=${subscriberNo}&month=${month}&year=${year}`)).body as any;
out.push(`Balance after: remaining **$${after.remainingBalance}** (status ${after.status})`);
const txId = `e2e-dup-${Date.now()}`;
const first = await http("POST", "/api/v1/pay", { token, body: { subscriberNo, month, year, amount: 1, transactionId: txId } });
const dup = await http("POST", "/api/v1/pay", { token, body: { subscriberNo, month, year, amount: 1, transactionId: txId } });
out.push(`**Direct Pay Bill API:** first \`${first.status}\`, duplicate transaction ID -> \`${dup.status}\``); block(dup.body);

console.log(out.join("\n"));
