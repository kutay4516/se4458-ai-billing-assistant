import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

process.env.DATABASE_URL = "";

describe("billing API", () => {
  it("returns health status", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
    await app.close();
  });

  it("returns the April 2025 seed bill", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/api/v1/bill/calculate", payload: { subscriberNo: "1001", month: 4, year: 2025 } });
    expect(response.statusCode).toBe(200);
    expect(response.json().phoneCharge).toBe(10);
    expect(response.json().internetCharge).toBe(20);
    await app.close();
  });

  it("labels MCP-only, REST-only, and combined agent scenarios", async () => {
    const app = buildServer();
    const mcp = await app.inject({ method: "POST", url: "/api/v1/agent/question", payload: { subscriberNo: "1001", question: "What is the internet allowance?" } });
    expect(mcp.statusCode).toBe(200);

    const rest = await app.inject({ method: "POST", url: "/api/v1/agent/question", payload: { subscriberNo: "1001", question: "Calculate my bill", month: 4, year: 2025 } });
    expect(rest.statusCode).toBe(200);

    const combined = await app.inject({ method: "POST", url: "/api/v1/agent/question", payload: { subscriberNo: "1001", question: "Why is my detailed internet charge high?", month: 4, year: 2025 } });
    expect(combined.statusCode).toBe(200);
    expect(combined.json().scenario).toBe("combined");
    await app.close();
  });

  it("adds usage and recalculates the bill", async () => {
    const app = buildServer();
    const tokenResponse = await app.inject({ method: "POST", url: "/api/v1/auth/token", payload: { subscriberNo: "1001", username: "subscriber1001", password: "change-me" } });
    const token = tokenResponse.json().token;
    const usageResponse = await app.inject({
      method: "POST", url: "/api/v1/usage",
      headers: { authorization: `Bearer ${token}` },
      payload: { subscriberNo: "1001", month: 5, year: 2025, usageType: "Phone", amount: 1100 },
    });
    expect(usageResponse.statusCode).toBe(201);

    const billResponse = await app.inject({ method: "POST", url: "/api/v1/bill/calculate", payload: { subscriberNo: "1001", month: 5, year: 2025 } });
    expect(billResponse.statusCode).toBe(200);
    expect(billResponse.json().phoneCharge).toBe(10);
    await app.close();
  });

  it("records a partial payment and rejects duplicate transactions", async () => {
    const app = buildServer();
    const tokenResponse = await app.inject({ method: "POST", url: "/api/v1/auth/token", payload: { subscriberNo: "1001", username: "subscriber1001", password: "change-me" } });
    const token = tokenResponse.json().token;
    const headers = { authorization: `Bearer ${token}` };
    const payment = { subscriberNo: "1001", month: 4, year: 2025, amount: 10, transactionId: `test-tx-${Date.now()}` };

    const first = await app.inject({ method: "POST", url: "/api/v1/pay", headers, payload: payment });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("SUCCESS");

    const duplicate = await app.inject({ method: "POST", url: "/api/v1/pay", headers, payload: payment });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe("DUPLICATE_TRANSACTION");
    await app.close();
  });

  it("rejects invalid credentials", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST", url: "/api/v1/auth/token",
      payload: { subscriberNo: "1001", username: "subscriber1001", password: "wrong-password" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("INVALID_CREDENTIALS");
    await app.close();
  });

  it("rejects mismatched subscriber identity", async () => {
    const app = buildServer();
    const tokenResponse = await app.inject({ method: "POST", url: "/api/v1/auth/token", payload: { subscriberNo: "1001", username: "subscriber1001", password: "change-me" } });
    const response = await app.inject({
      method: "POST", url: "/api/v1/pay",
      headers: { authorization: `Bearer ${tokenResponse.json().token}` },
      payload: { subscriberNo: "2002", month: 4, year: 2025, amount: 10, transactionId: "tx-mismatch" },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects protected detailed access without authentication", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/v1/bill/detailed?subscriberNo=1001&month=4&year=2025" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
