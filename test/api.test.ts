import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bearer, login, makeApi } from "./helpers.js";

let app: FastifyInstance;
let t1001: string;
let t1002: string;

beforeAll(async () => {
  ({ app } = await makeApi());
  t1001 = await login(app, "1001");
  t1002 = await login(app, "1002");
});
afterAll(async () => { await app.close(); });

const call = (method: "GET" | "POST", url: string, token?: string, payload?: unknown) =>
  app.inject({ method, url, headers: token ? bearer(token) : undefined, payload: payload as any });

describe("Auth: POST /api/v1/auth/token", () => {
  it("issues a JWT for valid credentials", async () => {
    const res = await call("POST", "/api/v1/auth/token", undefined, { subscriberNo: "1001", password: "unit-test-password" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tokenType: "Bearer", expiresIn: 3600, subscriberNo: "1001" });
    expect(app.jwt.decode<any>(res.json().token)).toMatchObject({ sub: "1001", role: "subscriber" });
  });
  it("rejects wrong password and unknown subscriber with the same 401", async () => {
    const wrong = await call("POST", "/api/v1/auth/token", undefined, { subscriberNo: "1001", password: "nope" });
    const unknown = await call("POST", "/api/v1/auth/token", undefined, { subscriberNo: "9999", password: "unit-test-password" });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json().error.code).toBe("INVALID_CREDENTIALS");
  });
  it("validates the body", async () => {
    expect((await call("POST", "/api/v1/auth/token", undefined, { subscriberNo: "1001" })).statusCode).toBe(400);
    expect((await call("POST", "/api/v1/auth/token", undefined, { subscriberNo: "bad subscriber!", password: "x" })).statusCode).toBe(400);
  });
});

describe("Add Usage: POST /api/v1/usage (authenticated)", () => {
  const body = { subscriberNo: "1001", month: 1, year: 2027 };
  it("adds 10 minutes of phone usage", async () => {
    const res = await call("POST", "/api/v1/usage", t1001, { ...body, usageType: "Phone" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "SUCCESS", usageType: "Phone", added: 10, unit: "minutes" });
  });
  it("adds 1 MB of internet usage", async () => {
    const res = await call("POST", "/api/v1/usage", t1001, { ...body, usageType: "Internet" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ added: 1, unit: "MB" });
  });
  it("requires authentication", async () => {
    expect((await call("POST", "/api/v1/usage", undefined, { ...body, usageType: "Phone" })).statusCode).toBe(401);
    expect((await call("POST", "/api/v1/usage", "not-a-jwt", { ...body, usageType: "Phone" })).statusCode).toBe(401);
  });
  it("forbids adding usage to another subscriber", async () => {
    const res = await call("POST", "/api/v1/usage", t1002, { ...body, usageType: "Phone" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN_SUBSCRIBER");
  });
  it("rejects invalid usage type, month and the removed amount field", async () => {
    expect((await call("POST", "/api/v1/usage", t1001, { ...body, usageType: "SMS" })).statusCode).toBe(400);
    expect((await call("POST", "/api/v1/usage", t1001, { ...body, month: 13, usageType: "Phone" })).statusCode).toBe(400);
    expect((await call("POST", "/api/v1/usage", t1001, { ...body, usageType: "Phone", amount: 99999 })).statusCode).toBe(400);
  });
});

describe("Calculate Bill: POST /api/v1/bill/calculate (authenticated)", () => {
  it("applies the assignment pricing: Oct 2026 = $20 phone + $80 internet", async () => {
    const res = await call("POST", "/api/v1/bill/calculate", t1001, { subscriberNo: "1001", month: 10, year: 2026 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "CALCULATED", bill: { phoneMinutes: 2300, internetMb: 47000, internetGb: 47, phoneCharge: 20, internetBaseCharge: 50, internetOverageCharge: 30, internetCharge: 80, total: 100, status: "UNPAID" } });
  });
  it("edge: exactly at the allowances costs only the $50 package", async () => {
    const res = await call("POST", "/api/v1/bill/calculate", t1002, { subscriberNo: "1002", month: 10, year: 2026 });
    expect(res.json().bill).toMatchObject({ phoneCharge: 0, internetCharge: 50, total: 50 });
  });
  it("requires authentication and ownership", async () => {
    expect((await call("POST", "/api/v1/bill/calculate", undefined, { subscriberNo: "1001", month: 10, year: 2026 })).statusCode).toBe(401);
    expect((await call("POST", "/api/v1/bill/calculate", t1002, { subscriberNo: "1001", month: 10, year: 2026 })).statusCode).toBe(403);
  });
  it("validates month/year", async () => {
    expect((await call("POST", "/api/v1/bill/calculate", t1001, { subscriberNo: "1001", month: 0, year: 2026 })).statusCode).toBe(400);
    expect((await call("POST", "/api/v1/bill/calculate", t1001, { subscriberNo: "1001", month: 5, year: 1999 })).statusCode).toBe(400);
  });
});

describe("Query Bill: GET /api/v1/bill (public)", () => {
  it("returns total, paid amount, remaining balance and status without authentication", async () => {
    const res = await call("GET", "/api/v1/bill?subscriberNo=1001&month=9&year=2026");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subscriberNo: "1001", month: 9, year: 2026, total: 50, paidAmount: 0, remainingBalance: 50, status: "UNPAID" });
  });
  it("404s when no bill was calculated for the period", async () => {
    const res = await call("GET", "/api/v1/bill?subscriberNo=1001&month=2&year=2020");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("BILL_NOT_FOUND");
  });
  it("validates query parameters", async () => {
    expect((await call("GET", "/api/v1/bill?subscriberNo=1001&month=13&year=2026")).statusCode).toBe(400);
    expect((await call("GET", "/api/v1/bill?subscriberNo=1001&year=2026")).statusCode).toBe(400);
  });
  it("when a token is presented it must belong to the same subscriber", async () => {
    expect((await call("GET", "/api/v1/bill?subscriberNo=1001&month=9&year=2026", t1001)).statusCode).toBe(200);
    expect((await call("GET", "/api/v1/bill?subscriberNo=1001&month=9&year=2026", t1002)).statusCode).toBe(403);
    expect((await call("GET", "/api/v1/bill?subscriberNo=1001&month=9&year=2026", "garbage")).statusCode).toBe(401);
  });
});

describe("Query Bill Detailed: GET /api/v1/bill/detailed (authenticated, paged)", () => {
  it("returns breakdown, paged usage records and payments", async () => {
    const res = await call("GET", "/api/v1/bill/detailed?subscriberNo=1001&month=10&year=2026", t1001);
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.bill).toMatchObject({ phoneMinutes: 2300, internetMb: 47000, internetGb: 47, phoneCharge: 20, internetBaseCharge: 50, internetOverageCharge: 30, total: 100 });
    expect(json.usage).toMatchObject({ page: 1, pageSize: 20, totalItems: 2, totalPages: 1 });
    expect(json.usage.items).toHaveLength(2);
    expect(json.payments).toEqual([]);
  });
  it("pages through many usage records", async () => {
    for (let i = 0; i < 25; i += 1) await call("POST", "/api/v1/usage", t1002, { subscriberNo: "1002", month: 11, year: 2026, usageType: "Phone" });
    await call("POST", "/api/v1/bill/calculate", t1002, { subscriberNo: "1002", month: 11, year: 2026 });
    const p3 = (await call("GET", "/api/v1/bill/detailed?subscriberNo=1002&month=11&year=2026&page=3&pageSize=10", t1002)).json();
    expect(p3.usage).toMatchObject({ page: 3, pageSize: 10, totalItems: 25, totalPages: 3 });
    expect(p3.usage.items).toHaveLength(5);
    expect(p3.bill.phoneMinutes).toBe(250);
  });
  it("requires authentication and ownership (even when the number is supplied)", async () => {
    expect((await call("GET", "/api/v1/bill/detailed?subscriberNo=1001&month=10&year=2026")).statusCode).toBe(401);
    expect((await call("GET", "/api/v1/bill/detailed?subscriberNo=1001&month=10&year=2026", t1002)).statusCode).toBe(403);
  });
  it("404s for an uncalculated period and 400s on bad paging", async () => {
    expect((await call("GET", "/api/v1/bill/detailed?subscriberNo=1001&month=3&year=2020", t1001)).statusCode).toBe(404);
    expect((await call("GET", "/api/v1/bill/detailed?subscriberNo=1001&month=10&year=2026&pageSize=101", t1001)).statusCode).toBe(400);
    expect((await call("GET", "/api/v1/bill/detailed?subscriberNo=1001&month=10&year=2026&page=0", t1001)).statusCode).toBe(400);
  });
});

describe("Pay Bill: POST /api/v1/pay (authenticated)", () => {
  const pay = (token: string | undefined, payload: Record<string, unknown>) => call("POST", "/api/v1/pay", token, { subscriberNo: "1001", month: 4, year: 2025, ...payload });

  it("records a partial payment and updates balance and status", async () => {
    const res = await pay(t1001, { amount: 30, transactionId: "api-tx-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "SUCCESS", paidAmount: 30, remainingBalance: 50, billStatus: "PARTIAL" });
    const bill = (await call("GET", "/api/v1/bill?subscriberNo=1001&month=4&year=2025")).json();
    expect(bill).toMatchObject({ total: 80, paidAmount: 30, remainingBalance: 50, status: "PARTIAL" });
  });
  it("rejects a duplicate transaction ID and leaves the balance unchanged", async () => {
    const dup = await pay(t1001, { amount: 5, transactionId: "api-tx-1" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("DUPLICATE_TRANSACTION");
    expect((await call("GET", "/api/v1/bill?subscriberNo=1001&month=4&year=2025")).json().paidAmount).toBe(30);
  });
  it("rejects amounts above the remaining balance", async () => {
    const res = await pay(t1001, { amount: 50.01, transactionId: "api-tx-over" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PAYMENT_EXCEEDS_BALANCE");
  });
  it("completes the bill with a full payment and then refuses further payments", async () => {
    const full = await pay(t1001, { amount: 50, transactionId: "api-tx-2" });
    expect(full.json()).toMatchObject({ remainingBalance: 0, billStatus: "PAID" });
    expect((await pay(t1001, { amount: 1, transactionId: "api-tx-3" })).json().error.code).toBe("NO_BALANCE_DUE");
  });
  it("requires authentication and ownership", async () => {
    expect((await pay(undefined, { amount: 1, transactionId: "x1" })).statusCode).toBe(401);
    expect((await pay(t1002, { amount: 1, transactionId: "x2" })).statusCode).toBe(403);
  });
  it("validates amount and transaction id", async () => {
    expect((await pay(t1001, { amount: 0, transactionId: "v1" })).statusCode).toBe(400);
    expect((await pay(t1001, { amount: -5, transactionId: "v2" })).statusCode).toBe(400);
    expect((await pay(t1001, { amount: 1.005, transactionId: "v3" })).json().error.code).toBe("INVALID_AMOUNT");
    expect((await pay(t1001, { amount: 5, transactionId: "" })).statusCode).toBe(400);
  });
  it("404s when no bill exists for the period", async () => {
    const res = await call("POST", "/api/v1/pay", t1001, { subscriberNo: "1001", month: 1, year: 2020, amount: 5, transactionId: "nb1" });
    expect(res.statusCode).toBe(404);
  });
});

describe("Documentation", () => {
  it("serves a generated OpenAPI document covering every operation and the bearer scheme", async () => {
    const spec = (await app.inject({ method: "GET", url: "/docs/json" })).json();
    expect(Object.keys(spec.paths).sort()).toEqual(["/api/v1/auth/token", "/api/v1/bill", "/api/v1/bill/calculate", "/api/v1/bill/detailed", "/api/v1/pay", "/api/v1/usage"]);
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ scheme: "bearer", bearerFormat: "JWT" });
    expect(spec.paths["/api/v1/bill"].get.security).toBeUndefined();
    expect(spec.paths["/api/v1/bill/detailed"].get.security).toEqual([{ bearerAuth: [] }]);
    const ui = await app.inject({ method: "GET", url: "/docs/" });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers["content-type"]).toContain("text/html");
  });
  it("answers unknown routes with the common error envelope", async () => {
    const res = await call("GET", "/api/v2/bill");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("ROUTE_NOT_FOUND");
  });
});
