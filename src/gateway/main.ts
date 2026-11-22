import "dotenv/config";
import { buildGateway } from "./app.js";

const app = buildGateway({
  apiBase: process.env.BILLING_API_URL ?? "http://127.0.0.1:3000",
  agentBase: process.env.AGENT_URL ?? "http://127.0.0.1:3003",
  logger: true,
});
await app.listen({ port: Number(process.env.GATEWAY_PORT ?? 3001), host: "0.0.0.0" });
