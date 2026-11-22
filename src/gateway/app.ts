import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { jwtSecret } from "../config.js";
import { ROUTES, UPSTREAM_PATH, type RouteDef } from "./routes.js";

export interface GatewayOptions {
  apiBase: string;
  agentBase: string;
  logger?: boolean;
  fetchImpl?: typeof fetch;
  /** Multiplies every route limit; lets tests exercise 429 quickly. */
  rateLimitOverride?: number;
}

declare module "fastify" {
  interface FastifyRequest { principal?: { sub: string } }
  interface FastifyContextConfig { route?: RouteDef }
}

const errorBody = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });

export function buildGateway(options: GatewayOptions) {
  const doFetch = options.fetchImpl ?? fetch;
  const app = Fastify({ logger: options.logger ?? false, genReqId: (req) => (req.headers["x-request-id"] as string) || randomUUID() });

  app.register(cors, { origin: true, exposedHeaders: ["x-request-id", "x-gateway-route", "retry-after"] });
  app.register(jwt, { secret: jwtSecret() });

  // 1. Authentication at the edge (runs before rate limiting so limits are keyed by verified identity).
  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.config?.route;
    reply.header("x-request-id", request.id);
    if (!route) return;
    reply.header("x-gateway-route", route.id);
    if (route.auth === "none") return;
    try {
      await request.jwtVerify();
      request.principal = { sub: (request.user as { sub: string }).sub };
    } catch {
      return reply.status(401).send(errorBody("UNAUTHORIZED", "A valid Bearer token is required for this route", request.id));
    }
  });

  // 2. Rate limiting keyed by subscriber identity (verified JWT), falling back to client IP for public routes.
  app.register(rateLimit, {
    global: false,
    hook: "preHandler",
    keyGenerator: (request) => (request.principal ? `sub:${request.principal.sub}` : `ip:${request.ip}`),
    errorResponseBuilder: (request, context) => ({
      statusCode: 429,
      ...errorBody("RATE_LIMITED", `Rate limit exceeded: ${context.max} requests per ${context.after}. Retry later.`, request.id),
    }),
  });

  app.setNotFoundHandler((request, reply) => reply.status(404).send(errorBody("ROUTE_NOT_FOUND", `No gateway route for ${request.method} ${request.url.split("?")[0]}`, request.id)));
  app.setErrorHandler((error: any, request, reply) => {
    // @fastify/rate-limit throws the object built by errorResponseBuilder; keep its envelope as is.
    if (error?.error?.code) return reply.status(error.statusCode ?? 500).send({ error: error.error });
    const status = error?.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    return reply.status(status).send(errorBody(error?.code ?? "GATEWAY_ERROR", status === 500 ? "Unexpected gateway error" : error.message, request.id));
  });

  // Routes are registered inside a plugin so that the rate-limit plugin's onRoute hook is guaranteed to see them.
  app.register(async function routes(gw) {
    gw.get("/health", async () => ({ status: "ok", service: "api-gateway", upstreams: { api: options.apiBase, agent: options.agentBase } }));
    gw.get("/gateway/routes", async () => ({
      version: "v1",
      routes: ROUTES.map((r) => ({ id: r.id, method: r.method, publicPath: r.path, upstream: r.upstream, upstreamPath: UPSTREAM_PATH[r.path] ?? r.path, auth: r.auth, rateLimit: r.rateLimit, description: r.description })),
    }));

    async function forward(route: RouteDef, request: FastifyRequest, reply: FastifyReply) {
      const base = route.upstream === "agent" ? options.agentBase : options.apiBase;
      const queryIndex = request.url.indexOf("?");
      // Wildcard routes (Swagger UI) are passed through under the same path; all others use the fixed mapping.
      const pathOnly = queryIndex >= 0 ? request.url.slice(0, queryIndex) : request.url;
      const upstreamPath = route.path.endsWith("*") || route.id === "swagger-ui" ? pathOnly : UPSTREAM_PATH[route.path] ?? route.path;
      const url = `${base}${upstreamPath}${queryIndex >= 0 ? request.url.slice(queryIndex) : ""}`;
      const headers: Record<string, string> = { accept: route.id.startsWith("swagger") ? "*/*" : "application/json", "x-request-id": request.id, "x-forwarded-for": request.ip };
      if (request.headers.authorization) headers.authorization = request.headers.authorization;
      let body: string | undefined;
      if (request.method !== "GET" && request.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(request.body);
      }
      try {
        const upstream = await doFetch(url, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(route.upstream === "agent" ? 240_000 : 15_000) });
        reply.status(upstream.status).header("content-type", upstream.headers.get("content-type") ?? "application/json");
        const location = upstream.headers.get("location");
        if (location) reply.header("location", location);
        return reply.send(Buffer.from(await upstream.arrayBuffer())); // buffer, not text: Swagger UI serves binary assets
      } catch (error: any) {
        request.log.error({ err: error, upstream: route.upstream }, "upstream failure");
        return reply.status(error?.name === "TimeoutError" ? 504 : 502).send(
          errorBody(error?.name === "TimeoutError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE", `The ${route.upstream} service did not respond`, request.id));
      }
    }

    for (const route of ROUTES) {
      const limit = options.rateLimitOverride ?? route.rateLimit.max;
      gw.route({
        method: route.method,
        url: route.path,
        config: { route, rateLimit: { max: limit, timeWindow: route.rateLimit.timeWindow } },
        handler: (request, reply) => forward(route, request, reply),
      });
    }
  });

  return app;
}
