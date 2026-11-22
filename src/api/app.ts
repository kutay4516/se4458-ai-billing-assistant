import cors from "@fastify/cors";
import { createHash, timingSafeEqual } from "node:crypto";
import jwt from "@fastify/jwt";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { jwtSecret, JWT_EXPIRES_IN_SECONDS } from "../config.js";
import { hasAtMostTwoDecimals } from "../billing/pricing.js";
import type { BillingStore } from "../billing/store.js";
import { DomainError } from "../billing/types.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: "subscriber" };
    user: { sub: string; role: "subscriber" };
  }
}

const subscriberNo = { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$", description: "Subscriber number", examples: ["1001"] } as const;
const month = { type: "integer", minimum: 1, maximum: 12, examples: [10] } as const;
const year = { type: "integer", minimum: 2000, maximum: 2100, examples: [2026] } as const;

const errorSchema = {
  type: "object",
  properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {} } } },
} as const;

const billSchema = {
  type: "object",
  properties: {
    subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" },
    phoneMinutes: { type: "number" }, internetMb: { type: "number" }, internetGb: { type: "number" },
    phoneCharge: { type: "number" }, internetBaseCharge: { type: "number" }, internetOverageCharge: { type: "number" }, internetCharge: { type: "number" },
    total: { type: "number" }, paidAmount: { type: "number" }, remainingBalance: { type: "number" },
    status: { type: "string", enum: ["UNPAID", "PARTIAL", "PAID"] }, calculatedAt: { type: "string" },
  },
} as const;

const billSummarySchema = {
  type: "object",
  properties: {
    subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" },
    total: { type: "number" }, paidAmount: { type: "number" }, remainingBalance: { type: "number" },
    status: { type: "string", enum: ["UNPAID", "PARTIAL", "PAID"] },
  },
} as const;

const paymentSchema = {
  type: "object",
  properties: {
    transactionId: { type: "string" }, subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" },
    amount: { type: "number" }, createdAt: { type: "string" },
  },
} as const;

const secured = [{ bearerAuth: [] }];
const authErrors = {
  400: { description: "Validation error", ...errorSchema },
  401: { description: "Missing or invalid JWT", ...errorSchema },
  403: { description: "JWT subscriber differs from the requested subscriber", ...errorSchema },
};

export interface ApiOptions {
  store: BillingStore;
  logger?: boolean;
  /** When set, every request except /health must carry this value in `x-gateway-key` (only the API Gateway knows it). */
  gatewayKey?: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function buildApi({ store, logger = false, gatewayKey }: ApiOptions) {
  const app = Fastify({ logger, ajv: { customOptions: { coerceTypes: "array", removeAdditional: false } } });

  // Defence in depth: the API may have a public address (e.g. on Azure "express" environments), but only the gateway holds the key.
  if (gatewayKey) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.url.split("?")[0] === "/health") return;
      const presented = request.headers["x-gateway-key"];
      if (typeof presented !== "string" || !timingSafeEqual(digest(presented), digest(gatewayKey))) {
        return reply.status(403).send({ error: { code: "GATEWAY_REQUIRED", message: "This service accepts requests only through the API Gateway" } });
      }
    });
  }

  app.register(cors, { origin: true });
  app.register(jwt, { secret: jwtSecret(), sign: { expiresIn: JWT_EXPIRES_IN_SECONDS } });
  app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Mobile Provider Billing API",
        version: "1.0.0",
        description: "Versioned REST API (/api/v1) for usage, billing and simulated payments. Public clients reach it through the API Gateway.",
      },
      tags: [
        { name: "Authentication" }, { name: "Usage" }, { name: "Billing" }, { name: "Payments" }, { name: "System" },
      ],
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    },
  });
  app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(error.httpStatus).send({ error: { code: error.code, message: error.message } });
    }
    if (error?.validation) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: error.message, details: error.validation } });
    }
    if (error?.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ error: { code: error.code ?? "BAD_REQUEST", message: error.message } });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } });
  });
  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: "ROUTE_NOT_FOUND", message: "Route not found" } }));

  /** Verifies the bearer token and attaches the principal. */
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "A valid Bearer token is required" } });
    }
  };

  /** Authorization: the JWT principal may only act on its own subscriber number. */
  const assertSelf = (request: FastifyRequest, requested: string) => {
    if (request.user.sub !== requested) {
      throw new DomainError("FORBIDDEN_SUBSCRIBER", 403, "The authenticated subscriber may only access their own data");
    }
  };

  // Routes live in a plugin registered AFTER swagger so the OpenAPI document sees every route.
  app.register(async function routes(api) {
    api.get("/health", { schema: { hide: true, tags: ["System"], summary: "Health check", response: { 200: { type: "object", properties: { status: { type: "string" }, service: { type: "string" } } } } } },
      async () => ({ status: "ok", service: "billing-api" }));

    api.post("/api/v1/auth/token", {
      schema: {
        tags: ["Authentication"], summary: "Exchange subscriber credentials for a JWT",
        body: { type: "object", required: ["subscriberNo", "password"], additionalProperties: false, properties: { subscriberNo, password: { type: "string", minLength: 1, maxLength: 200 } } },
        response: {
          200: { type: "object", properties: { token: { type: "string" }, tokenType: { type: "string" }, expiresIn: { type: "integer" }, subscriberNo: { type: "string" } } },
          400: authErrors[400], 401: { description: "Invalid credentials", ...errorSchema },
        },
      },
    }, async (request) => {
      const body = request.body as { subscriberNo: string; password: string };
      if (!(await store.verifyCredentials(body.subscriberNo, body.password))) {
        throw new DomainError("INVALID_CREDENTIALS", 401, "Invalid subscriber number or password");
      }
      const token = api.jwt.sign({ sub: body.subscriberNo, role: "subscriber" });
      return { token, tokenType: "Bearer", expiresIn: JWT_EXPIRES_IN_SECONDS, subscriberNo: body.subscriberNo };
    });

    api.post("/api/v1/usage", {
      preHandler: authenticate,
      schema: {
        tags: ["Usage"], summary: "Add Usage: +10 minutes of phone or +1 MB of internet", security: secured,
        body: { type: "object", required: ["subscriberNo", "month", "year", "usageType"], additionalProperties: false,
          properties: { subscriberNo, month, year, usageType: { type: "string", enum: ["Phone", "Internet"] } } },
        response: {
          201: { type: "object", properties: { status: { type: "string" }, subscriberNo: { type: "string" }, month: { type: "integer" }, year: { type: "integer" }, usageType: { type: "string" }, added: { type: "number" }, unit: { type: "string" } } },
          ...authErrors, 404: { description: "Unknown subscriber", ...errorSchema },
        },
      },
    }, async (request, reply) => {
      const body = request.body as { subscriberNo: string; month: number; year: number; usageType: "Phone" | "Internet" };
      assertSelf(request, body.subscriberNo);
      const result = await store.addUsage(body);
      return reply.status(201).send({ status: "SUCCESS", ...result });
    });

    api.post("/api/v1/bill/calculate", {
      preHandler: authenticate,
      schema: {
        tags: ["Billing"], summary: "Calculate Bill: snapshot the period's usage into a persisted bill", security: secured,
        description: "Phone: first 1,000 minutes free, then $10 per started 1,000-minute block. Internet: $50 up to 20 GB, then $10 per started additional 10 GB block (1 GB = 1,000 MB).",
        body: { type: "object", required: ["subscriberNo", "month", "year"], additionalProperties: false, properties: { subscriberNo, month, year } },
        response: { 200: { type: "object", properties: { status: { type: "string" }, bill: billSchema } }, ...authErrors, 404: { description: "Unknown subscriber", ...errorSchema } },
      },
    }, async (request) => {
      const body = request.body as { subscriberNo: string; month: number; year: number };
      assertSelf(request, body.subscriberNo);
      return { status: "CALCULATED", bill: await store.calculateBill(body.subscriberNo, body.month, body.year) };
    });

    api.get("/api/v1/bill", {
      schema: {
        tags: ["Billing"], summary: "Query Bill: total, paid amount, remaining balance and status (no authentication per assignment)",
        description: "Public by assignment requirement. If an Authorization header is supplied it is validated and must belong to the same subscriber.",
        querystring: { type: "object", required: ["subscriberNo", "month", "year"], properties: { subscriberNo, month, year } },
        response: { 200: billSummarySchema, 400: authErrors[400], 401: authErrors[401], 403: authErrors[403], 404: { description: "No calculated bill for the period", ...errorSchema } },
      },
    }, async (request) => {
      const query = request.query as { subscriberNo: string; month: number; year: number };
      if (request.headers.authorization) {
        try { await request.jwtVerify(); } catch { throw new DomainError("UNAUTHORIZED", 401, "Invalid Bearer token"); }
        assertSelf(request, query.subscriberNo);
      }
      const bill = await store.getBill(query.subscriberNo, query.month, query.year);
      if (!bill) throw new DomainError("BILL_NOT_FOUND", 404, "No calculated bill exists for this period");
      return bill;
    });

    api.get("/api/v1/bill/detailed", {
      preHandler: authenticate,
      schema: {
        tags: ["Billing"], summary: "Query Bill Detailed: charge breakdown, usage (paged) and payments", security: secured,
        querystring: { type: "object", required: ["subscriberNo", "month", "year"], properties: {
          subscriberNo, month, year,
          page: { type: "integer", minimum: 1, default: 1, description: "1-based page of usage records" },
          pageSize: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        } },
        response: {
          200: { type: "object", properties: {
            bill: billSchema,
            usage: { type: "object", properties: {
              items: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, usageType: { type: "string" }, amount: { type: "number" }, unit: { type: "string" }, recordedAt: { type: "string" } } } },
              page: { type: "integer" }, pageSize: { type: "integer" }, totalItems: { type: "integer" }, totalPages: { type: "integer" },
            } },
            payments: { type: "array", items: paymentSchema },
          } },
          ...authErrors, 404: { description: "No calculated bill for the period", ...errorSchema },
        },
      },
    }, async (request) => {
      const query = request.query as { subscriberNo: string; month: number; year: number; page: number; pageSize: number };
      assertSelf(request, query.subscriberNo);
      const detailed = await store.getBillDetailed(query.subscriberNo, query.month, query.year, { page: query.page ?? 1, pageSize: query.pageSize ?? 20 });
      if (!detailed) throw new DomainError("BILL_NOT_FOUND", 404, "No calculated bill exists for this period");
      return detailed;
    });

    api.post("/api/v1/pay", {
      preHandler: authenticate,
      schema: {
        tags: ["Payments"], summary: "Pay Bill: record a simulated partial or full payment", security: secured,
        description: "No real card processing. Duplicate transaction IDs are rejected (409); amounts above the remaining balance are rejected (422).",
        body: { type: "object", required: ["subscriberNo", "month", "year", "amount", "transactionId"], additionalProperties: false,
          properties: { subscriberNo, month, year, amount: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000, examples: [25.5] }, transactionId: { type: "string", minLength: 1, maxLength: 128 } } },
        response: {
          200: { type: "object", properties: { status: { type: "string" }, paidAmount: { type: "number" }, remainingBalance: { type: "number" }, billStatus: { type: "string" }, payment: paymentSchema, bill: billSchema } },
          ...authErrors,
          404: { description: "No calculated bill", ...errorSchema }, 409: { description: "Duplicate transaction ID", ...errorSchema }, 422: { description: "Amount exceeds balance / nothing due", ...errorSchema },
        },
      },
    }, async (request) => {
      const body = request.body as { subscriberNo: string; month: number; year: number; amount: number; transactionId: string };
      assertSelf(request, body.subscriberNo);
      if (!hasAtMostTwoDecimals(body.amount)) throw new DomainError("INVALID_AMOUNT", 400, "Amount may have at most two decimal places");
      const { payment, bill } = await store.payBill(body);
      return { status: "SUCCESS", paidAmount: payment.amount, remainingBalance: bill.remainingBalance, billStatus: bill.status, payment, bill };
    });
  });

  return app;
}
