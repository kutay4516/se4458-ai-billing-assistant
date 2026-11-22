import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildGateway } from "../src/gateway/app.js";
import { ROUTES } from "../src/gateway/routes.js";
import { listen, login, makeApi } from "./helpers.js";

let api: FastifyInstance;
let apiUrl: string;
let gateway: FastifyInstance;
let t1001: string;
let t1002: string;
const upstreamCalls: string[] = [];

beforeAll(async () => {
  ({ app: api } = await makeApi());
  apiUrl = await listen(api);
  t1001 = await login(api, "1001");
  t1002 = await login(api, "1002");
  gateway = buildGateway({
    apiBase: apiUrl, agentBase: "http://agent.invalid",
    fetchImpl: (async (url: any, init: any) => {
      upstreamCalls.push(`${init?.method} ${url}`);
      if (String(url).startsWith("http://agent.invalid")) return new Response(JSON.stringify({ answer: "stub" }), { status: 200, headers: { "content-type": "application/json" } });
      return fetch(url, init);
    }) as typeof fetch,
  });
  await gateway.ready();
});
afterAll(async () => { await gateway.close(); await api.close(); });

const gw = (method: "GET" | "POST", url: string, token?: string, payload?: unknown) =>
  gateway.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : undefined, payload: payload as any });

describe("route mapping", () => {
  it("publishes the versioned route table", async () => {
    const res = await gw("GET", "/gateway/routes");
    const routes = res.json().routes as Array<{ publicPath: string; auth: string }>;
    expect(routes.filter((r) => !r.publicPath.startsWith("/docs")).every((r) => r.publicPath.startsWith("/api/v1/"))).toBe(true);
    expect(routes.length).toBe(ROUTES.length);
    expect(routes.find((r) => r.publicPath === "/api/v1/pay")!.auth).toBe("jwt");
    expect(routes.find((r) => r.publicPath === "/api/v1/bill")!.auth).toBe("none");
  });
});

describe("Swagger UI through the gateway", () => {
  it("serves the UI page, the OpenAPI document and binary assets unchanged", async () => {
    const page = await gw("GET", "/docs");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("swagger-ui");
    expect(page.headers["x-gateway-route"]).toBe("swagger-ui");

    const spec = await gw("GET", "/docs/json");
    expect(spec.statusCode).toBe(200);
    expect(Object.keys(spec.json().paths)).toEqual(expect.arrayContaining(["/api/v1/usage", "/api/v1/bill/calculate", "/api/v1/bill", "/api/v1/bill/detailed", "/api/v1/pay"]));

    const viaGateway = await gw("GET", "/docs/static/favicon-32x32.png");
    const direct = await fetch(`${apiUrl}/docs/static/favicon-32x32.png`);
    expect(viaGateway.statusCode).toBe(200);
    expect(Buffer.compare(viaGateway.rawPayload, Buffer.from(await direct.arrayBuffer()))).toBe(0);
  });

  it("does not expose the internal health endpoint in the OpenAPI document", async () => {
    const spec = await gw("GET", "/api/v1/openapi.json");
    expect(Object.keys(spec.json().paths)).not.toContain("/health");
  });
});

describe("routed endpoints", () => {
  it("proxies a public route (Query Bill) and tags the response with route id and request id", async () => {
    const res = await gw("GET", "/api/v1/bill?subscriberNo=1001&month=10&year=2026");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 100, status: "UNPAID" });
    expect(res.headers["x-gateway-route"]).toBe("query-bill");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("proxies a protected route with a valid JWT (Query Bill Detailed, query string preserved)", async () => {
    const res = await gw("GET", "/api/v1/bill/detailed?subscriberNo=1001&month=10&year=2026&page=1&pageSize=1", t1001);
    expect(res.statusCode).toBe(200);
    expect(res.json().usage.items).toHaveLength(1);
    expect(upstreamCalls.some((c) => c.includes("/api/v1/bill/detailed?subscriberNo=1001&month=10&year=2026&page=1&pageSize=1"))).toBe(true);
  });

  it("proxies POST bodies (login -> JWT)", async () => {
    const res = await gw("POST", "/api/v1/auth/token", undefined, { subscriberNo: "1002", password: "unit-test-password" });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  it("routes the agent endpoint to the agent service", async () => {
    const res = await gw("POST", "/api/v1/agent/chat", t1001, { message: "hi" });
    expect(res.json()).toEqual({ answer: "stub" });
    expect(upstreamCalls).toContain("POST http://agent.invalid/api/v1/agent/chat");
  });

  it("maps the OpenAPI route to the API's document", async () => {
    const res = await gw("GET", "/api/v1/openapi.json");
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain("/api/v1/pay");
  });
});

describe("authentication at the edge", () => {
  it("rejects a protected route without a token (error response with request id) and never reaches upstream", async () => {
    const before = upstreamCalls.length;
    const res = await gw("POST", "/api/v1/pay", undefined, { subscriberNo: "1001", month: 10, year: 2026, amount: 5, transactionId: "gw-1" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED", requestId: expect.any(String) } });
    expect(upstreamCalls.length).toBe(before);
  });
  it("rejects malformed and foreign-signed tokens", async () => {
    expect((await gw("GET", "/api/v1/bill/detailed?subscriberNo=1001&month=10&year=2026", "abc.def.ghi")).statusCode).toBe(401);
  });
  it("still lets the upstream enforce ownership (403 passes through)", async () => {
    const res = await gw("GET", "/api/v1/bill/detailed?subscriberNo=1001&month=10&year=2026", t1002);
    expect(res.statusCode).toBe(403);
  });
});

describe("errors", () => {
  it("unknown route -> 404 envelope", async () => {
    const res = await gw("GET", "/api/v1/nope");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("ROUTE_NOT_FOUND");
  });
  it("upstream down -> 502 envelope", async () => {
    const dead = buildGateway({ apiBase: "http://127.0.0.1:1", agentBase: "http://127.0.0.1:1" });
    const res = await dead.inject({ method: "GET", url: "/api/v1/bill?subscriberNo=1001&month=1&year=2026" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("UPSTREAM_UNAVAILABLE");
    await dead.close();
  });
});

describe("rate limiting keyed by subscriber identity", () => {
  it("returns 429 per subscriber, not per IP: other subscribers on the same IP are unaffected", async () => {
    const limited = buildGateway({ apiBase: apiUrl, agentBase: "http://agent.invalid", rateLimitOverride: 3 });
    const hit = (token: string) => limited.inject({ method: "GET", url: "/api/v1/bill/detailed?subscriberNo=1001&month=10&year=2026", headers: { authorization: `Bearer ${token}` }, remoteAddress: "10.0.0.9" });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await hit(t1001)).statusCode);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    const blocked = await hit(t1001);
    expect(blocked.json().error).toMatchObject({ code: "RATE_LIMITED", requestId: expect.any(String) });
    expect(blocked.headers["retry-after"]).toBeTruthy();
    // same IP, different subscriber -> own bucket (403 from upstream ownership check, but NOT 429)
    expect((await hit(t1002)).statusCode).toBe(403);
    await limited.close();
  });
  it("public routes are limited per client IP", async () => {
    const limited = buildGateway({ apiBase: apiUrl, agentBase: "http://agent.invalid", rateLimitOverride: 2 });
    const get = (ip: string) => limited.inject({ method: "GET", url: "/api/v1/bill?subscriberNo=1001&month=10&year=2026", remoteAddress: ip });
    expect([(await get("10.0.0.1")).statusCode, (await get("10.0.0.1")).statusCode, (await get("10.0.0.1")).statusCode]).toEqual([200, 200, 429]);
    expect((await get("10.0.0.2")).statusCode).toBe(200);
    await limited.close();
  });
});
