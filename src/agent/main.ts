import "dotenv/config";
import { buildAgentApp } from "./app.js";
import { GatewayRestClient, McpDocsClient } from "./clients.js";
import { llmFromEnv } from "./llm.js";
import { SessionStore } from "./sessions.js";

const gatewayUrl = process.env.GATEWAY_URL ?? "http://127.0.0.1:3001";
const llm = llmFromEnv();
if (!llm) console.warn("[agent] LLM_API_KEY is not set: /api/v1/agent/chat will answer 503 until it is configured.");

const app = buildAgentApp({
  llm,
  docs: McpDocsClient.overHttp(process.env.MCP_URL ?? "http://127.0.0.1:3002/mcp"),
  rest: new GatewayRestClient(gatewayUrl),
  sessions: new SessionStore(),
  gatewayPublicUrl: process.env.GATEWAY_PUBLIC_URL ?? gatewayUrl,
  logger: true,
});
await app.listen({ port: Number(process.env.AGENT_PORT ?? 3003), host: "0.0.0.0" });
