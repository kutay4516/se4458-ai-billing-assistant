export type Upstream = "api" | "agent";

export interface RouteDef {
  id: string;
  method: "GET" | "POST";
  /** Public, versioned path exposed by the gateway (also the upstream path). */
  path: string;
  upstream: Upstream;
  auth: "none" | "jwt";
  rateLimit: { max: number; timeWindow: string };
  description: string;
}

/** Route mapping table: every REST operation of the project is reachable ONLY through these public routes. */
export const ROUTES: RouteDef[] = [
  { id: "auth-token",     method: "POST", path: "/api/v1/auth/token",     upstream: "api",   auth: "none", rateLimit: { max: 20, timeWindow: "1 minute" },  description: "Login: subscriber credentials -> JWT" },
  { id: "query-bill",     method: "GET",  path: "/api/v1/bill",           upstream: "api",   auth: "none", rateLimit: { max: 60, timeWindow: "1 minute" },  description: "Query Bill (public per assignment)" },
  { id: "query-detailed", method: "GET",  path: "/api/v1/bill/detailed",  upstream: "api",   auth: "jwt",  rateLimit: { max: 60, timeWindow: "1 minute" },  description: "Query Bill Detailed (paged, protected)" },
  { id: "calculate-bill", method: "POST", path: "/api/v1/bill/calculate", upstream: "api",   auth: "jwt",  rateLimit: { max: 30, timeWindow: "1 minute" },  description: "Calculate Bill (protected)" },
  { id: "add-usage",      method: "POST", path: "/api/v1/usage",          upstream: "api",   auth: "jwt",  rateLimit: { max: 120, timeWindow: "1 minute" }, description: "Add Usage (protected)" },
  { id: "pay-bill",       method: "POST", path: "/api/v1/pay",            upstream: "api",   auth: "jwt",  rateLimit: { max: 20, timeWindow: "1 minute" },  description: "Pay Bill (protected)" },
  { id: "agent-chat",     method: "POST", path: "/api/v1/agent/chat",     upstream: "agent", auth: "jwt",  rateLimit: { max: 30, timeWindow: "1 minute" },  description: "AI agent chat (protected)" },
  { id: "openapi",        method: "GET",  path: "/api/v1/openapi.json",   upstream: "api",   auth: "none", rateLimit: { max: 30, timeWindow: "1 minute" },  description: "OpenAPI document of the billing API" },
  { id: "swagger-ui",     method: "GET",  path: "/docs",                  upstream: "api",   auth: "none", rateLimit: { max: 120, timeWindow: "1 minute" }, description: "Swagger UI of the billing API (served through the gateway; Try it out calls the gateway routes)" },
  { id: "swagger-assets", method: "GET",  path: "/docs/*",                upstream: "api",   auth: "none", rateLimit: { max: 240, timeWindow: "1 minute" }, description: "Swagger UI assets and /docs/json" },
];

/** Gateway path -> upstream path (only the OpenAPI document differs). */
export const UPSTREAM_PATH: Record<string, string> = { "/api/v1/openapi.json": "/docs/json" };
