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

export function buildServer() {
  const app = Fastify({ logger: true });
  const memoryStore = new BillingStore();
  memoryStore.addUsage({ subscriberNo: "1001", month: 4, year: 2025, usageType: "Phone", amount: 1200 });
  memoryStore.addUsage({ subscriberNo: "1001", month: 4, year: 2025, usageType: "Internet", amount: 35000 });
  const store = process.env.DATABASE_URL
    ? new PostgresBillingStore(new pg.Pool({ connectionString: process.env.DATABASE_URL }))
    : memoryStore;

  app.register(cors, { origin: true });
  app.register(jwt, { secret: process.env.JWT_SECRET ?? "development-only-secret" });
  app.register(swagger, {
    openapi: {
      info: { title: "Mobile Provider Billing API", version: "1.0.0", description: "Versioned REST API for mobile billing, usage, payments, authentication, and AI agent operations." },
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    },
  });
  app.register(swaggerUi, { routePrefix: "/docs", uiConfig: { url: "/openapi-full.json", deepLinking: true } });

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

  app.get("/openapi-manual.json", async () => ({
    openapi: "3.0.3",
    info: { title: "Mobile Provider Billing API", version: "1.0.0", description: "Billing REST API with MCP, AI agent, authentication, gateway, and PostgreSQL support." },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    paths: {
      "/health": { get: { tags: ["System"], summary: "Check API health", responses: { "200": { description: "API is healthy" } } } },
      "/api/v1/bill": { get: { tags: ["Billing"], summary: "Query a subscriber bill", parameters: [{ name: "subscriberNo", in: "query", required: true, schema: { type: "string" } }, { name: "month", in: "query", required: true, schema: { type: "integer", minimum: 1, maximum: 12 } }, { name: "year", in: "query", required: true, schema: { type: "integer" } }], responses: { "200": { description: "Bill summary" }, "400": { description: "Invalid parameters" } } } },
      "/api/v1/bill/detailed": { get: { tags: ["Billing"], summary: "Query detailed bill, usage, and payments", security: [{ bearerAuth: [] }], parameters: [{ name: "subscriberNo", in: "query", required: true, schema: { type: "string" } }, { name: "month", in: "query", required: true, schema: { type: "integer" } }, { name: "year", in: "query", required: true, schema: { type: "integer" } }], responses: { "200": { description: "Detailed billing data" }, "401": { description: "Authentication required" } } } },
      "/api/v1/usage": { post: { tags: ["Usage"], summary: "Add subscriber usage", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["subscriberNo", "month", "year", "usageType", "amount"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" }, usageType: { type: "string", enum: ["Phone", "Internet"] }, amount: { type: "number" } } } } } }, responses: { "201": { description: "Usage added" } } } },
      "/api/v1/bill/calculate": { post: { tags: ["Billing"], summary: "Calculate a bill", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["subscriberNo", "month", "year"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" } } } } } }, responses: { "200": { description: "Calculated bill" } } } },
      "/api/v1/pay": { post: { tags: ["Payments"], summary: "Record a simulated payment", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["subscriberNo", "month", "year", "amount", "transactionId"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" }, amount: { type: "number" }, transactionId: { type: "string" } } } } } }, responses: { "200": { description: "Payment accepted" }, "409": { description: "Duplicate transaction" } } } },
      "/api/v1/auth/token": { post: { tags: ["Authentication"], summary: "Authenticate subscriber", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["subscriberNo", "username", "password"], properties: { subscriberNo: { type: "string" }, username: { type: "string" }, password: { type: "string", format: "password" } } } } } }, responses: { "200": { description: "JWT issued" }, "401": { description: "Invalid credentials" } } } },
      "/api/v1/agent/question": { post: { tags: ["AI Agent"], summary: "Ask a grounded billing question", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["subscriberNo", "question"], properties: { subscriberNo: { type: "string" }, question: { type: "string" }, month: { type: "integer" }, year: { type: "integer" } } } } } }, responses: { "200": { description: "Agent answer with tool trace" } } } },
    },
  }));

  app.get("/openapi-full.json", async () => ({
    openapi: "3.0.3",
    info: { title: "Mobile Provider Billing API", version: "1.0.0", description: "Billing REST API with MCP, AI agent, authentication, gateway, and PostgreSQL support." },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    paths: {
      "/health": { get: { tags: ["System"], summary: "Check API health", responses: { "200": { description: "API is healthy" } } } },
      "/api/v1/bill": { get: { tags: ["Billing"], summary: "Query a subscriber bill", parameters: [{ name: "subscriberNo", in: "query", required: true, schema: { type: "string" } }, { name: "month", in: "query", required: true, schema: { type: "integer", minimum: 1, maximum: 12 } }, { name: "year", in: "query", required: true, schema: { type: "integer" } }], responses: { "200": { description: "Bill summary" }, "400": { description: "Invalid parameters" } } } },
      "/api/v1/bill/detailed": { get: { tags: ["Billing"], summary: "Query detailed bill, usage, and payments", security: [{ bearerAuth: [] }], parameters: [{ name: "subscriberNo", in: "query", required: true, schema: { type: "string" } }, { name: "month", in: "query", required: true, schema: { type: "integer" } }, { name: "year", in: "query", required: true, schema: { type: "integer" } }], responses: { "200": { description: "Detailed billing data" }, "401": { description: "Authentication required" } } } },
      "/api/v1/usage": { post: { tags: ["Usage"], summary: "Add subscriber usage", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["subscriberNo", "month", "year", "usageType", "amount"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" }, usageType: { type: "string", enum: ["Phone", "Internet"] }, amount: { type: "number" } } } } } }, responses: { "201": { description: "Usage added" } } } },
      "/api/v1/bill/calculate": { post: { tags: ["Billing"], summary: "Calculate a bill", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["subscriberNo", "month", "year"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" } } } } } }, responses: { "200": { description: "Calculated bill" } } } },
      "/api/v1/pay": { post: { tags: ["Payments"], summary: "Record a simulated payment", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["subscriberNo", "month", "year", "amount", "transactionId"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" }, amount: { type: "number" }, transactionId: { type: "string" } } } } } }, responses: { "200": { description: "Payment accepted" }, "409": { description: "Duplicate transaction" } } } },
      "/api/v1/auth/token": { post: { tags: ["Authentication"], summary: "Authenticate subscriber", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["subscriberNo", "username", "password"], properties: { subscriberNo: { type: "string" }, username: { type: "string" }, password: { type: "string", format: "password" } } } } } }, responses: { "200": { description: "JWT issued" }, "401": { description: "Invalid credentials" } } } },
      "/api/v1/agent/question": { post: { tags: ["AI Agent"], summary: "Ask a grounded billing question", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["subscriberNo", "question"], properties: { subscriberNo: { type: "string" }, question: { type: "string" }, month: { type: "integer" }, year: { type: "integer" } } } } } }, responses: { "200": { description: "Agent answer with tool trace" } } } },
    },
  }));

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
    preHandler: subscriberOnly,
    schema: {
      tags: ["Billing"], summary: "Query detailed bill, usage, and payment data", security: [{ bearerAuth: [] }],
      querystring: { type: "object", required: ["subscriberNo", "month", "year"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" } } },
    },
  }, async (request, reply) => {
    const query = z.object({ subscriberNo: z.string().min(1), month: monthSchema, year: yearSchema }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "VALIDATION_ERROR", details: query.error.flatten() });
    const bill = await store.calculateBill(query.data.subscriberNo, query.data.month, query.data.year);
    return { bill, usage: await store.getUsage(query.data.subscriberNo, query.data.month, query.data.year), payments: await store.getPayments(query.data.subscriberNo, query.data.month, query.data.year) };
  });

  app.post("/api/v1/usage", {
    preHandler: subscriberOnly,
    schema: {
      tags: ["Usage"], summary: "Add subscriber usage", security: [{ bearerAuth: [] }],
      body: { type: "object", required: ["subscriberNo", "month", "year", "usageType", "amount"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" }, usageType: { type: "string", enum: ["Phone", "Internet"] }, amount: { type: "number" } } },
    },
  }, async (request, reply) => {
    const body = z.object({ subscriberNo: z.string().min(1), month: monthSchema, year: yearSchema, usageType: z.enum(["Phone", "Internet"]), amount: z.number().positive() }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "VALIDATION_ERROR", details: body.error.flatten() });
    return reply.status(201).send(await store.addUsage(body.data));
  });

  app.post("/api/v1/bill/calculate", {
    schema: {
      tags: ["Billing"], summary: "Calculate a subscriber bill",
      body: { type: "object", required: ["subscriberNo", "month", "year"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" } } },
    },
  }, async (request, reply) => {
    const body = z.object({ subscriberNo: z.string().min(1), month: monthSchema, year: yearSchema }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "VALIDATION_ERROR", details: body.error.flatten() });
    return await store.calculateBill(body.data.subscriberNo, body.data.month, body.data.year);
  });

  app.post("/api/v1/pay", {
    preHandler: subscriberOnly,
    schema: {
      tags: ["Payments"], summary: "Record a simulated payment", security: [{ bearerAuth: [] }],
      body: { type: "object", required: ["subscriberNo", "month", "year", "amount", "transactionId"], properties: { subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" }, amount: { type: "number" }, transactionId: { type: "string" } } },
    },
  }, async (request, reply) => {
    const body = z.object({ subscriberNo: z.string().min(1), month: monthSchema, year: yearSchema, amount: z.number().positive(), transactionId: z.string().min(1) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "VALIDATION_ERROR", details: body.error.flatten() });
    try {
      const result = await store.payBill(body.data);
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
    schema: {
      tags: ["AI Agent"], summary: "Ask the billing AI agent a grounded question",
      body: { type: "object", required: ["subscriberNo", "question"], properties: { subscriberNo: { type: "string" }, question: { type: "string" }, month: { type: "integer" }, year: { type: "integer" } } },
    },
  }, async (request, reply) => {
    const body = z.object({
      subscriberNo: z.string().min(1),
      question: z.string().min(3),
      month: monthSchema.optional(),
      year: yearSchema.optional(),
    }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "VALIDATION_ERROR", details: body.error.flatten() });

    const month = body.data.month ?? 4;
    const year = body.data.year ?? 2025;

    const policyText = await readFile("Mobile_Provider_Billing_Guide.md", "utf8");
    try {
      const live = await runLiveAgent({
        subscriberNo: body.data.subscriberNo,
        question: body.data.question,
        month,
        year,
        apiBase: `${process.env.BILLING_API_BASE ?? "http://127.0.0.1:3000"}/api/v1`,
        policyText,
      });
      if (live) return live;
    } catch (error) {
      app.log.warn({ error }, "Live LLM unavailable; using deterministic fallback");
    }
    const question = body.data.question.toLowerCase();
    const trace: Array<{ tool: string; input: unknown; result: unknown }> = [];

    if (question.includes("internet") || question.includes("phone") || question.includes("allowance") || question.includes("extra") || question.includes("payment") || question.includes("pay")) {
      const guide = await readFile("Mobile_Provider_Billing_Guide.md", "utf8");
      const relevant = guide
        .split("\n## ")
        .filter((section) => section.toLowerCase().split(/\W+/).some((term) => question.includes(term) && term.length > 3))
        .join("\n\n");
      trace.push({ tool: "search_billing_documentation", input: { query: body.data.question }, result: relevant || guide });
    }

    let answer = "I found the relevant billing policy. Which bill month should I calculate?";
    if (question.includes("bill") || question.includes("charge") || question.includes("usage") || question.includes("detailed")) {
      const bill = await store.calculateBill(body.data.subscriberNo, month, year);
      trace.push({ tool: question.includes("detailed") ? "query_bill_detailed" : "query_bill", input: { subscriberNo: body.data.subscriberNo, month, year }, result: bill });
      answer = `Bill for ${month}/${year}: total $${bill.total}, paid $${bill.paidAmount}, remaining $${bill.remainingBalance}, status ${bill.status}.`;
    }

    if (question.includes("add") && (question.includes("usage") || question.includes("gb") || question.includes("minute"))) {
      answer = "Usage is a write operation. Explicit confirmation is required before it can be added.";
    }

    if ((question.includes("pay bill") || question.includes("make a payment")) && !question.includes("confirmed")) {
      answer = "Payment requires explicit confirmation. Resend the request with confirmed: true and a transaction ID.";
    }

    let scenario = "rest-only";
    if (trace.length === 1) scenario = "mcp-only";
    if (trace.length > 1) scenario = "combined";

    return { answer, trace, model: process.env.LLM_MODEL ?? "deterministic-tool-orchestrator", scenario };
  });

  app.get("/", async (_request, reply) => {
    reply.type("text/html");
    return readFile("public/index.html", "utf8");
  });

  return app;
}

if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts")) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
}
