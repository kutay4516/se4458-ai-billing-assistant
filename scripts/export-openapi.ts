// Generates docs/openapi.json (billing REST API) and docs/openapi-agent.json (agent endpoint) from the route schemas.
import { writeFile } from "node:fs/promises";
import { buildApi } from "../src/api/app.js";
import { buildAgentApp } from "../src/agent/app.js";
import { MemoryBillingStore } from "../src/billing/memoryStore.js";
import { SessionStore } from "../src/agent/sessions.js";

const api = buildApi({ store: new MemoryBillingStore() });
await api.ready();
await writeFile("docs/openapi.json", JSON.stringify(api.swagger(), null, 2) + "\n");

const agent = buildAgentApp({
  llm: null, docs: { search: async () => ({}) }, rest: { call: async () => ({ status: 200, body: {} }) },
  sessions: new SessionStore(), gatewayPublicUrl: "http://localhost:3001",
});
await agent.ready();
await writeFile("docs/openapi-agent.json", JSON.stringify(agent.swagger(), null, 2) + "\n");
await Promise.all([api.close(), agent.close()]);
console.log("wrote docs/openapi.json and docs/openapi-agent.json");
