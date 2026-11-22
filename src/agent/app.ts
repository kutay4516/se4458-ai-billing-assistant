import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { jwtSecret } from "../config.js";
import { BillingAgent, type AgentDeps } from "./agent.js";
import { LlmError } from "./llm.js";

export interface AgentAppOptions extends Omit<AgentDeps, "llm"> {
  /** null when no LLM is configured: the chat route then answers 503 instead of faking tool selection. */
  llm: AgentDeps["llm"] | null;
  /** Public gateway URL the browser UI should call. */
  gatewayPublicUrl: string;
  logger?: boolean;
}

export function buildAgentApp(options: AgentAppOptions) {
  const app = Fastify({ logger: options.logger ?? false, ajv: { customOptions: { removeAdditional: false } } });
  const agent = options.llm ? new BillingAgent({ ...options, llm: options.llm }) : null;

  app.register(cors, { origin: true });
  app.register(jwt, { secret: jwtSecret() });
  app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: { title: "Billing AI Agent", version: "1.0.0", description: "LLM tool-calling agent. Reached through the API Gateway at /api/v1/agent/chat." },
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    },
  });
  app.register(swaggerUi, { routePrefix: "/docs" });

  const fail = (reply: any, status: number, code: string, message: string) => reply.status(status).send({ error: { code, message } });

  // Registered after swagger so the OpenAPI document includes these routes.
  app.register(async function routes(r) {
    r.get("/health", { schema: { hide: true } }, async () => ({ status: "ok", service: "billing-agent", llmConfigured: Boolean(options.llm) }));
    r.get("/config.json", { schema: { hide: true } }, async () => ({ gatewayUrl: options.gatewayPublicUrl }));
    r.get("/", { schema: { hide: true } }, async (_request, reply) => {
      reply.type("text/html; charset=utf-8");
      return readFile(path.resolve(process.cwd(), "public/index.html"), "utf8");
    });

    r.post("/api/v1/agent/chat", {
      schema: {
        tags: ["Agent"], summary: "Ask the billing assistant (LLM tool calling -> MCP and/or REST via gateway)", security: [{ bearerAuth: [] }],
        body: { type: "object", required: ["message"], additionalProperties: false, properties: {
          message: { type: "string", minLength: 1, maxLength: 2000 },
          conversationId: { type: "string", minLength: 1, maxLength: 64 },
          confirmActionId: { type: "string", minLength: 1, maxLength: 64, description: "Action id from pendingConfirmation; confirms the staged payment" },
        } },
      },
    }, async (request, reply) => {
      let subscriberNo: string;
      try {
        await request.jwtVerify();
        subscriberNo = (request.user as { sub: string }).sub;
      } catch {
        return fail(reply, 401, "UNAUTHORIZED", "A valid Bearer token is required");
      }
      if (!agent) return fail(reply, 503, "LLM_NOT_CONFIGURED", "No LLM is configured. Set LLM_API_KEY (see README).");

      const token = request.headers.authorization!.replace(/^Bearer\s+/i, "");
      try {
        return await agent.chat({ subscriberNo, token }, request.body as { message: string; conversationId?: string; confirmActionId?: string });
      } catch (error) {
        request.log.error({ err: error }, "agent failure");
        if (error instanceof LlmError) return fail(reply, 502, "LLM_ERROR", error.message);
        return fail(reply, 500, "AGENT_ERROR", "The assistant failed to process the request");
      }
    });
  });

  app.setErrorHandler((error: any, _request, reply) => {
    if (error?.validation) return fail(reply, 400, "VALIDATION_ERROR", error.message);
    return fail(reply, error?.statusCode && error.statusCode < 500 ? error.statusCode : 500, error?.code ?? "ERROR", error?.message ?? "Error");
  });

  return app;
}
