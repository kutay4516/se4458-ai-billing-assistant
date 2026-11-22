import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { basename } from "node:path";

const upstream = process.env.BILLING_API_BASE ?? "http://127.0.0.1:3000";
export function buildGateway(apiOrigin = upstream) {
const gateway = Fastify({ logger: true });
gateway.register(cors, { origin: true, allowedHeaders: ["content-type", "authorization"], methods: ["GET", "POST", "OPTIONS"] });

async function proxy(request: any, reply: any, upstreamPath: string) {
  const url = new URL(upstreamPath, apiOrigin);
  if (request.query && Object.keys(request.query).length) {
    url.search = new URLSearchParams(request.query).toString();
  }

  const response = await fetch(url, {
    method: request.method,
    headers: {
      "content-type": "application/json",
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
    },
    body: request.method === "GET" || request.method === "HEAD" ? undefined : JSON.stringify(request.body),
  });

  reply.status(response.status);
  return response.json();
}

gateway.get("/health", async () => ({ status: "ok", service: "api-gateway", upstream: apiOrigin }));
gateway.get("/gateway/v1", async () => ({
  service: "billing-api-gateway",
  version: "v1",
  health: "/gateway/v1/health",
  openapi: "/gateway/v1/openapi.json",
}));
gateway.get("/gateway/v1/health", async (request, reply) => proxy(request, reply, "/health"));
gateway.get("/gateway/v1/bill", async (request, reply) => proxy(request, reply, "/api/v1/bill"));
gateway.post("/gateway/v1/auth/token", async (request, reply) => proxy(request, reply, "/api/v1/auth/token"));
gateway.post("/gateway/v1/agent/question", async (request, reply) => proxy(request, reply, "/api/v1/agent/question"));
gateway.post("/gateway/v1/bill/calculate", async (request, reply) => proxy(request, reply, "/api/v1/bill/calculate"));
gateway.get("/gateway/v1/bill/detailed", async (request, reply) => proxy(request, reply, "/api/v1/bill/detailed"));
gateway.post("/gateway/v1/usage", async (request, reply) => proxy(request, reply, "/api/v1/usage"));
gateway.post("/gateway/v1/pay", async (request, reply) => proxy(request, reply, "/api/v1/pay"));

gateway.get("/gateway/v1/openapi.json", async (request, reply) => proxy(request, reply, "/docs/json"));

return gateway;
}

if (["server.js", "server.ts"].includes(basename(process.argv[1] ?? ""))) {
  const gateway = buildGateway();
  await gateway.listen({ port: Number(process.env.GATEWAY_PORT ?? 3001), host: "0.0.0.0" });
}
