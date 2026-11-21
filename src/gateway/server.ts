import "dotenv/config";
import Fastify from "fastify";

const upstream = process.env.BILLING_API_BASE ?? "http://127.0.0.1:3000";
const gateway = Fastify({ logger: true });

async function proxy(request: any, reply: any, upstreamPath: string) {
  const url = new URL(upstreamPath, upstream);
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

gateway.get("/health", async () => ({ status: "ok", service: "api-gateway", upstream }));
gateway.get("/gateway/v1/bill", async (request, reply) => proxy(request, reply, "/api/v1/bill"));
gateway.post("/gateway/v1/bill/calculate", async (request, reply) => proxy(request, reply, "/api/v1/bill/calculate"));
gateway.get("/gateway/v1/bill/detailed", async (request, reply) => proxy(request, reply, "/api/v1/bill/detailed"));
gateway.post("/gateway/v1/usage", async (request, reply) => proxy(request, reply, "/api/v1/usage"));
gateway.post("/gateway/v1/pay", async (request, reply) => proxy(request, reply, "/api/v1/pay"));

gateway.get("/gateway/v1/openapi.json", async (request, reply) => proxy(request, reply, "/documentation/json"));

await gateway.listen({ port: Number(process.env.GATEWAY_PORT ?? 3001), host: "0.0.0.0" });
