import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { BillingStore } from "./billing/store.js";
import { PostgresBillingStore } from "./billing/postgresStore.js";
import { runLiveAgent } from "./agent/llm.js";
import { closeBillingMcpClient, searchBillingDocumentation } from "./agent/mcpClient.js";
import { scenarioForTrace } from "./agent/scenario.js";

export async function buildServer() {
  const app = Fastify({ logger: true });
  const memoryStore = new BillingStore();
  memoryStore.addUsage({ subscriberNo: "1001", month: 4, year: 2025, usageType: "Phone", amount: 1200 });
  memoryStore.addUsage({ subscriberNo: "1001", month: 4, year: 2025, usageType: "Internet", amount: 35000 });
  const store = process.env.DATABASE_URL
    ? new PostgresBillingStore(new pg.Pool({ connectionString: process.env.DATABASE_URL }))
    : memoryStore;

  app.register(cors, { origin: true });
  app.register(jwt, { secret: process.env.JWT_SECRET ?? "development-only-secret" });
  await app.register(swagger, {
    openapi: {
      info: { title: "Mobile Provider Billing API", version: "1.0.0", description: "Versioned REST API for mobile billing, usage, payments, authentication, and AI agent operations." },
      servers: [{ url: process.env.GATEWAY_PUBLIC_URL ?? "http://localhost:3001/gateway/v1" }],
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    },
    transform: ({ schema, url }) => ({
      schema,
      url: url.startsWith("/api/v1/") ? url.replace(/^\/api\/v1/, "") : url,
    }),
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { deepLinking: true, docExpansion: "full", filter: true },
    uiHooks: {
      onRequest: async (_request, reply) => { reply.header("cache-control", "no-store"); },
    },
  });
  app.addHook("onClose", closeBillingMcpClient);

  const monthSchema = z.coerce.number().int().min(1).max(12);
  const yearSchema = z.coerce.number().int().min(2000).max(2100);

  const subscriberOnly = async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
      const subscriberNo = (request as any).body?.subscriberNo ?? (request.query as any)?.subscriberNo;
      const principal = (request as any).user as { subscriberNo?: string };
      if (subscriberNo && principal.subscriberNo !== subscriberNo) {
        return reply.status(403).send({ error: "SUBSCRIBER_MISMATCH" });
      }
    } catch {
      return reply.status(401).send({ error: "UNAUTHORIZED" });
    }
  };

  app.get("/config.js", { schema: { hide: true } }, async (_request, reply) => {
    const gatewayPublicUrl = process.env.GATEWAY_PUBLIC_URL ?? "http://localhost:3001/gateway/v1";
    reply.header("cache-control", "no-store").type("application/javascript; charset=utf-8");
    return `window.BILLING_GATEWAY_BASE_URL = ${JSON.stringify(gatewayPublicUrl)};`;
  });

  app.get("/health", {
    schema: { tags: ["System"], summary: "Check API health", response: { 200: { type: "object", properties: { status: { type: "string" }, service: { type: "string" } } } } },
  }, () => ({ status: "ok", service: "billing-api" }));

  app.get("/api/v1/bill", {
    schema: {
      tags: ["Billing"],
      summary: "Query a subscriber bill",
      querystring: {
        type: "object",
        required: ["subscriberNo", "month", "year"],
        properties: {
          subscriberNo: { type: "string" },
          month: { type: "integer", minimum: 1, maximum: 12 },
          year: { type: "integer" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            subscriberNo: { type: "string" },
            month: { type: "integer" },
            year: { type: "integer" },
            total: { type: "number" },
            remainingBalance: { type: "number" },
            status: { type: "string" },
          },
        },
        400: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const query = z.object({ subscriberNo: z.string().min(1), month: monthSchema, year: yearSchema }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "VALIDATION_ERROR", details: query.error.flatten() });
    return await store.calculateBill(query.data.subscriberNo, query.data.month, query.data.year);
  });

  app.get("/api/v1/bill/detailed", {
    preValidation: subscriberOnly,
    schema: {
      tags: ["Billing"], summary: "Query detailed bill, usage, and payment data", security: [{ bearerAuth: [] }],
      querystring: { type: "object", required: ["subscriberNo", "month", "year"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" }, page: { type: "integer", minimum: 1, default: 1 }, pageSize: { type: "integer", minimum: 1, maximum: 100, default: 10 } } },
    },
  }, async (request, reply) => {
    const query = z.object({ subscriberNo: z.string().min(1), month: monthSchema, year: yearSchema, page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(10) }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "VALIDATION_ERROR", details: query.error.flatten() });
    const { subscriberNo, month, year, page, pageSize } = query.data;
    const bill = await store.calculateBill(subscriberNo, month, year);
    const usage = await store.getUsage(subscriberNo, month, year);
    const payments = await store.getPayments(subscriberNo, month, year);
    const paginate = <T,>(items: T[]) => ({ page, pageSize, total: items.length, items: items.slice((page - 1) * pageSize, page * pageSize) });
    return {
      bill: { ...bill, internetGb: bill.internetMb / 1000, chargeBreakdown: { phone: bill.phoneCharge, internet: bill.internetCharge } },
      usage: paginate(usage), payments: paginate(payments),
    };
  });

  app.post("/api/v1/usage", {
    preValidation: subscriberOnly,
    schema: {
      tags: ["Usage"], summary: "Add subscriber usage", security: [{ bearerAuth: [] }],
      body: { type: "object", required: ["subscriberNo", "month", "year", "usageType", "amount"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" }, usageType: { type: "string", enum: ["Phone", "Internet"] }, amount: { type: "number" }, confirmed: { type: "boolean", description: "Must be true to authorize this write" } } },
    },
  }, async (request, reply) => {
    const body = z.object({ subscriberNo: z.string().min(1), month: monthSchema, year: yearSchema, usageType: z.enum(["Phone", "Internet"]), amount: z.number().positive(), confirmed: z.boolean().optional() }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "VALIDATION_ERROR", details: body.error.flatten() });
    if (body.data.confirmed !== true) return reply.status(400).send({ error: "CONFIRMATION_REQUIRED" });
    const { confirmed: _confirmed, ...usage } = body.data;
    return reply.status(201).send(await store.addUsage(usage));
  });

  app.post("/api/v1/bill/calculate", {
    preValidation: subscriberOnly,
    schema: {
      tags: ["Billing"], summary: "Calculate a subscriber bill", security: [{ bearerAuth: [] }],
      body: { type: "object", required: ["subscriberNo", "month", "year"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" } } },
    },
  }, async (request, reply) => {
    const body = z.object({ subscriberNo: z.string().min(1), month: monthSchema, year: yearSchema }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "VALIDATION_ERROR", details: body.error.flatten() });
    return await store.calculateBill(body.data.subscriberNo, body.data.month, body.data.year);
  });

  app.post("/api/v1/pay", {
    preValidation: subscriberOnly,
    schema: {
      tags: ["Payments"], summary: "Record a simulated payment", security: [{ bearerAuth: [] }],
      body: { type: "object", required: ["subscriberNo", "month", "year", "amount", "transactionId"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" }, amount: { type: "number" }, transactionId: { type: "string" }, confirmed: { type: "boolean", description: "Must be true to authorize this payment" } } },
    },
  }, async (request, reply) => {
    const body = z.object({ subscriberNo: z.string().min(1), month: monthSchema, year: yearSchema, amount: z.number().positive(), transactionId: z.string().min(1), confirmed: z.boolean().optional() }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "VALIDATION_ERROR", details: body.error.flatten() });
    if (body.data.confirmed !== true) return reply.status(400).send({ status: "REJECTED", error: "CONFIRMATION_REQUIRED" });
    try {
      const { confirmed: _confirmed, ...payment } = body.data;
      const result = await store.payBill(payment);
      return reply.status(200).send({ status: "SUCCESS", payment: result.payment, bill: result.bill });
    } catch (error) {
      const message = error instanceof Error ? error.message : "PAYMENT_FAILED";
      return reply.status(message === "DUPLICATE_TRANSACTION" ? 409 : 400).send({ status: "REJECTED", error: message });
    }
  });

  app.post("/api/v1/auth/token", {
    schema: {
      tags: ["Authentication"], summary: "Authenticate a subscriber and issue a JWT",
      body: { type: "object", required: ["subscriberNo", "username", "password"], properties: { subscriberNo: { type: "string" }, username: { type: "string" }, password: { type: "string", format: "password" } } },
    },
  }, async (request, reply) => {
    const body = z.object({
      subscriberNo: z.string().min(1),
      username: z.string().min(1),
      password: z.string().min(1),
    }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "VALIDATION_ERROR" });

    const configuredSubscriber = process.env.DEMO_SUBSCRIBER_NO ?? "1001";
    const configuredUsername = process.env.DEMO_USERNAME ?? "subscriber1001";
    const configuredPassword = process.env.DEMO_PASSWORD ?? "change-me";

    const authenticated = body.data.subscriberNo === configuredSubscriber
      && body.data.username === configuredUsername
      && body.data.password === configuredPassword;

    if (!authenticated) return reply.status(401).send({ error: "INVALID_CREDENTIALS" });
    return { token: app.jwt.sign({ subscriberNo: configuredSubscriber, role: "subscriber" }) };
  });

  app.post("/api/v1/agent/question", {
    preValidation: subscriberOnly,
    schema: {
      tags: ["AI Agent"], summary: "Ask the billing AI agent a grounded question", security: [{ bearerAuth: [] }],
      body: { type: "object", required: ["subscriberNo", "question"], properties: { subscriberNo: { type: "string" }, question: { type: "string" }, month: { type: "integer" }, year: { type: "integer" }, confirmed: { type: "boolean" } } },
    },
  }, async (request, reply) => {
    const body = z.object({
      subscriberNo: z.string().min(1),
      question: z.string().min(3),
      month: monthSchema.optional(),
      year: yearSchema.optional(),
      confirmed: z.boolean().optional(),
    }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "VALIDATION_ERROR", details: body.error.flatten() });

    const month = body.data.month ?? 4;
    const year = body.data.year ?? 2025;
    const gatewayBase = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:3001/gateway/v1";
    const authorization = request.headers.authorization;

    try {
      const live = await runLiveAgent({
        subscriberNo: body.data.subscriberNo,
        question: body.data.question,
        month,
        year,
        gatewayBase,
        bearerToken: authorization?.slice("Bearer ".length),
        confirmed: body.data.confirmed === true,
      });
      if (live) return live;
    } catch (error) {
      app.log.warn({ error }, "Live LLM unavailable; using deterministic fallback");
    }
    const question = body.data.question.toLowerCase();
    const trace: Array<{ tool: string; input: unknown; result: unknown }> = [];

    if (question.includes("internet") || question.includes("phone") || question.includes("allowance") || question.includes("extra") || question.includes("payment") || question.includes("pay")) {
      const policy = await searchBillingDocumentation(body.data.question);
      trace.push({ tool: "search_billing_documentation", input: { query: body.data.question }, result: policy });
    }

    let answer = "I found the relevant billing policy. Which bill month should I calculate?";
    if (question.includes("bill") || question.includes("charge") || question.includes("usage") || question.includes("detailed")) {
      const params = new URLSearchParams({ subscriberNo: body.data.subscriberNo, month: String(month), year: String(year) });
      const detailed = question.includes("detailed");
      const response = await fetch(`${gatewayBase}/bill${detailed ? `/detailed?${params}` : `?${params}`}`, { headers: { authorization: authorization ?? "" } });
      const bill = await response.json();
      if (!response.ok) return reply.status(response.status).send(bill);
      trace.push({ tool: detailed ? "query_bill_detailed" : "query_bill", input: { subscriberNo: body.data.subscriberNo, month, year }, result: bill });
      const summary = detailed ? bill.bill : bill;
      answer = `Bill for ${month}/${year}: total $${summary.total}, paid $${summary.paidAmount}, remaining $${summary.remainingBalance}, status ${summary.status}.`;
    }

    if (question.includes("add") && (question.includes("usage") || question.includes("gb") || question.includes("minute"))) {
      answer = "Usage is a write operation. Explicit confirmation is required before it can be added.";
    }

    if ((question.includes("pay bill") || question.includes("make a payment")) && !question.includes("confirmed")) {
      answer = "Payment requires explicit confirmation. Resend the request with confirmed: true and a transaction ID.";
    }

    return { answer, trace, model: process.env.LLM_MODEL ?? "deterministic-tool-orchestrator", scenario: scenarioForTrace(trace) };
  });

  app.get("/", { schema: { hide: true } }, async (_request, reply) => {
    reply.type("text/html");
    return readFile("public/index.html", "utf8");
  });

  return app;
}

if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts")) {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
}
