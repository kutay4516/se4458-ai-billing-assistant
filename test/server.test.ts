import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { buildGateway } from "../src/gateway/server.js";

process.env.DATABASE_URL = "";
process.env.LLM_API_KEY = "";
process.env.GATEWAY_PUBLIC_URL = "http://localhost:3001/gateway/v1";

async function issueToken(app: Awaited<ReturnType<typeof buildServer>>, subscriberNo = "1001") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/token", payload: { subscriberNo, username: "subscriber1001", password: "change-me" } });
  return response.json().token as string;
}

describe("billing API", () => {
  it("returns health status", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
    await app.close();
  });

  it("serves generated Swagger UI and its static bundle from /docs", async () => {
    const app = await buildServer();
    const docs = await app.inject({ method: "GET", url: "/docs" });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers["cache-control"]).toBe("no-store");
    expect(docs.body).toContain("/docs/static/swagger-ui-bundle.js");
    const initializer = await app.inject({ method: "GET", url: "/docs/static/swagger-initializer.js" });
    expect(initializer.statusCode).toBe(200);
    expect(initializer.body).toContain("resolveUrl('./json')");
    const bundle = await app.inject({ method: "GET", url: "/docs/static/swagger-ui-bundle.js" });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.headers["content-type"]).toContain("javascript");
    const css = await app.inject({ method: "GET", url: "/docs/static/swagger-ui.css" });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    const spec = await app.inject({ method: "GET", url: "/docs/json" });
    expect(spec.statusCode).toBe(200);
    expect(spec.json().paths["/bill/detailed"].get.parameters.map((p: { name: string }) => p.name)).toContain("page");
    expect(spec.json().paths["/bill/calculate"].post.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.json().paths["/usage"].post.requestBody.content["application/json"].schema.properties.confirmed.description).toContain("Must be true");
    expect(spec.json().servers[0].url).toBe("http://localhost:3001/gateway/v1");
    expect((await app.inject({ method: "GET", url: "/openapi-full.json" })).statusCode).toBe(404);
    await app.close();
  });

  it("returns the April 2025 seed bill", async () => {
    const app = await buildServer();
    const token = await issueToken(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/bill/calculate", headers: { authorization: `Bearer ${token}` }, payload: { subscriberNo: "1001", month: 4, year: 2025 } });
    expect(response.statusCode).toBe(200);
    expect(response.json().phoneCharge).toBe(10);
    expect(response.json().internetCharge).toBe(20);
    await app.close();
  });

  it("labels MCP-only, REST-only, and combined agent scenarios", async () => {
    const originalGateway = process.env.GATEWAY_BASE_URL;
    const app = await buildServer();
    const apiAddress = await app.listen({ host: "127.0.0.1", port: 0 });
    const gateway = buildGateway(apiAddress);
    const gatewayAddress = await gateway.listen({ host: "127.0.0.1", port: 0 });
    process.env.GATEWAY_BASE_URL = `${gatewayAddress}/gateway/v1`;
    try {
      const token = await issueToken(app);
      const headers = { authorization: `Bearer ${token}` };
      const gatewayIndex = await gateway.inject({ method: "GET", url: "/gateway/v1" });
      expect(gatewayIndex.statusCode).toBe(200);
      expect(gatewayIndex.json().openapi).toBe("/gateway/v1/openapi.json");
      const preflight = await gateway.inject({ method: "OPTIONS", url: "/gateway/v1/agent/question", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
      const mcp = await gateway.inject({ method: "POST", url: "/gateway/v1/agent/question", headers, payload: { subscriberNo: "1001", question: "What is the internet allowance?" } });
      expect(mcp.statusCode).toBe(200);
      expect(mcp.json().scenario).toBe("mcp-only");
      expect(mcp.json().trace[0].result).toContain("[allowances]");
      const rest = await gateway.inject({ method: "POST", url: "/gateway/v1/agent/question", headers, payload: { subscriberNo: "1001", question: "Calculate my bill", month: 4, year: 2025 } });
      expect(rest.statusCode).toBe(200);
      expect(rest.json().scenario).toBe("rest-only");
      const combined = await gateway.inject({ method: "POST", url: "/gateway/v1/agent/question", headers, payload: { subscriberNo: "1001", question: "Why is my detailed internet charge high?", month: 4, year: 2025 } });
      expect(combined.statusCode).toBe(200);
      expect(combined.json().scenario).toBe("combined");
    } finally {
      await gateway.close();
      await app.close();
      if (originalGateway === undefined) delete process.env.GATEWAY_BASE_URL;
      else process.env.GATEWAY_BASE_URL = originalGateway;
    }
  });

  it("adds usage and recalculates the bill", async () => {
    const app = await buildServer();
    const token = await issueToken(app);
    const unauthorized = await app.inject({ method: "POST", url: "/api/v1/usage", payload: { subscriberNo: "1001", month: 5, year: 2025, usageType: "Phone", amount: 10 } });
    expect(unauthorized.statusCode).toBe(401);
    const unconfirmed = await app.inject({ method: "POST", url: "/api/v1/usage", headers: { authorization: `Bearer ${token}` }, payload: { subscriberNo: "1001", month: 5, year: 2025, usageType: "Phone", amount: 10 } });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toBe("CONFIRMATION_REQUIRED");
    const invalid = await app.inject({ method: "POST", url: "/api/v1/usage", headers: { authorization: `Bearer ${token}` }, payload: { subscriberNo: "1001", month: 5, year: 2025, usageType: "Phone", amount: -1, confirmed: true } });
    expect(invalid.statusCode).toBe(400);
    const usageResponse = await app.inject({
      method: "POST", url: "/api/v1/usage",
      headers: { authorization: `Bearer ${token}` },
      payload: { subscriberNo: "1001", month: 5, year: 2025, usageType: "Phone", amount: 1100, confirmed: true },
    });
    expect(usageResponse.statusCode).toBe(201);

    const billResponse = await app.inject({ method: "POST", url: "/api/v1/bill/calculate", headers: { authorization: `Bearer ${token}` }, payload: { subscriberNo: "1001", month: 5, year: 2025 } });
    expect(billResponse.statusCode).toBe(200);
    expect(billResponse.json().phoneCharge).toBe(10);
    await app.close();
  });

  it("records a partial payment and rejects duplicate transactions", async () => {
    const app = await buildServer();
    const token = await issueToken(app);
    const headers = { authorization: `Bearer ${token}` };
    const payment = { subscriberNo: "1001", month: 4, year: 2025, amount: 10, transactionId: `test-tx-${Date.now()}`, confirmed: true };

    const first = await app.inject({ method: "POST", url: "/api/v1/pay", headers, payload: payment });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("SUCCESS");

    const duplicate = await app.inject({ method: "POST", url: "/api/v1/pay", headers, payload: payment });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe("DUPLICATE_TRANSACTION");
    await app.close();
  });

  it("rejects invalid credentials", async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/v1/auth/token",
      payload: { subscriberNo: "1001", username: "subscriber1001", password: "wrong-password" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("INVALID_CREDENTIALS");
    await app.close();
  });

  it("validates public bill inputs and protects agent requests", async () => {
    const app = await buildServer();
    const bill = await app.inject({ method: "GET", url: "/api/v1/bill?subscriberNo=1001&month=4&year=2025" });
    expect(bill.statusCode).toBe(200);
    expect(bill.json().total).toBe(30);
    const invalidBill = await app.inject({ method: "GET", url: "/api/v1/bill?subscriberNo=1001&month=13&year=2025" });
    expect(invalidBill.statusCode).toBe(400);
    const unauthorizedAgent = await app.inject({ method: "POST", url: "/api/v1/agent/question", payload: { subscriberNo: "1001", question: "Explain my bill" } });
    expect(unauthorizedAgent.statusCode).toBe(401);
    await app.close();
  });

  it("rejects mismatched subscriber identity", async () => {
    const app = await buildServer();
    const token = await issueToken(app);
    const response = await app.inject({
      method: "POST", url: "/api/v1/pay",
      headers: { authorization: `Bearer ${token}` },
      payload: { subscriberNo: "2002", month: 4, year: 2025, amount: 10, transactionId: "tx-mismatch", confirmed: true },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects protected detailed access without authentication", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/api/v1/bill/detailed?subscriberNo=1001&month=4&year=2025" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("protects calculate and detailed routes and pages detailed rows", async () => {
    const app = await buildServer();
    const noToken = await app.inject({ method: "POST", url: "/api/v1/bill/calculate", payload: { subscriberNo: "1001", month: 4, year: 2025 } });
    expect(noToken.statusCode).toBe(401);
    const token = await issueToken(app);
    const mismatch = await app.inject({ method: "POST", url: "/api/v1/bill/calculate", headers: { authorization: `Bearer ${token}` }, payload: { subscriberNo: "2002", month: 4, year: 2025 } });
    expect(mismatch.statusCode).toBe(403);
    const invalidMonth = await app.inject({ method: "POST", url: "/api/v1/bill/calculate", headers: { authorization: `Bearer ${token}` }, payload: { subscriberNo: "1001", month: 13, year: 2025 } });
    expect(invalidMonth.statusCode).toBe(400);
    const missingConfirmation = await app.inject({ method: "POST", url: "/api/v1/pay", headers: { authorization: `Bearer ${token}` }, payload: { subscriberNo: "1001", month: 4, year: 2025, amount: 5, transactionId: "unconfirmed-payment" } });
    expect(missingConfirmation.statusCode).toBe(400);
    expect(missingConfirmation.json().error).toBe("CONFIRMATION_REQUIRED");
    const paid = await app.inject({ method: "POST", url: "/api/v1/pay", headers: { authorization: `Bearer ${token}` }, payload: { subscriberNo: "1001", month: 4, year: 2025, amount: 5, transactionId: "paging-payment", confirmed: true } });
    expect(paid.statusCode).toBe(200);
    const detailed = await app.inject({ method: "GET", url: "/api/v1/bill/detailed?subscriberNo=1001&month=4&year=2025&page=2&pageSize=1", headers: { authorization: `Bearer ${token}` } });
    expect(detailed.statusCode).toBe(200);
    expect(detailed.json().bill).toMatchObject({ phoneMinutes: 1200, internetMb: 35000, internetGb: 35, chargeBreakdown: { phone: 10, internet: 20 } });
    expect(detailed.json().usage).toMatchObject({ page: 2, pageSize: 1, total: 2 });
    expect(detailed.json().usage.items).toHaveLength(1);
    expect(detailed.json().payments).toMatchObject({ page: 2, pageSize: 1, total: 1, items: [] });
    const pastEnd = await app.inject({ method: "GET", url: "/api/v1/bill/detailed?subscriberNo=1001&month=4&year=2025&page=99&pageSize=1", headers: { authorization: `Bearer ${token}` } });
    expect(pastEnd.json().usage.items).toEqual([]);
    await app.close();
  });

  it("rejects payments above the remaining balance", async () => {
    const app = await buildServer();
    const token = await issueToken(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/pay", headers: { authorization: `Bearer ${token}` }, payload: { subscriberNo: "1001", month: 4, year: 2025, amount: 31, transactionId: "too-much", confirmed: true } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("PAYMENT_EXCEEDS_BALANCE");
    await app.close();
  });
});
