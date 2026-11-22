import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { indexBillingPolicy, searchBillingPolicy, searchIndexedBillingPolicy } from "../src/mcp/search.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { buildServer } from "../src/server.js";
import { buildGateway } from "../src/gateway/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

describe("MCP billing policy retrieval", () => {
  it("retrieves the internet allowance chunk", async () => {
    const policy = await readFile("Mobile_Provider_Billing_Guide.md", "utf8");
    const matches = searchBillingPolicy(policy, "internet 20 GB allowance");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.text).toContain("20 GB");
  });

  it("retrieves payment duplicate rules", async () => {
    const policy = await readFile("Mobile_Provider_Billing_Guide.md", "utf8");
    const matches = searchBillingPolicy(policy, "duplicate transaction payment");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((match) => match.text.includes("transaction ID"))).toBe(true);
  });

  it("retrieves no-match results safely", async () => {
    const policy = await readFile("Mobile_Provider_Billing_Guide.md", "utf8");
    expect(searchBillingPolicy(policy, "xyznotapolicyword")).toEqual([]);
  });

  it("indexes policy sections once and returns section references", async () => {
    const policy = await readFile("Mobile_Provider_Billing_Guide.md", "utf8");
    const index = indexBillingPolicy(policy);
    const matches = searchIndexedBillingPolicy(index, "internet charge block");
    expect(matches[0]?.id).toBe("extra-charges");
    expect(matches[0]?.text).toContain("10 GB");
  });
});

describe("MCP gateway tools", () => {
  it("routes protected calculate, usage, and payment tools through the gateway with confirmation", async () => {
    process.env.DATABASE_URL = "";
    const previousGateway = process.env.GATEWAY_BASE_URL;
    const api = await buildServer();
    const apiAddress = await api.listen({ host: "127.0.0.1", port: 0 });
    const gateway = buildGateway(apiAddress);
    const gatewayAddress = await gateway.listen({ host: "127.0.0.1", port: 0 });
    process.env.GATEWAY_BASE_URL = `${gatewayAddress}/gateway/v1`;
    const mcp = await buildMcpServer();
    const client = new Client({ name: "mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
      const base = { subscriberNo: "1001", month: 4, year: 2025 };
      const calculated = await client.callTool({ name: "calculate_bill", arguments: base });
      expect(calculated.isError).not.toBe(true);
      expect(calculated.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining('"total":30') }));

      const unconfirmed = await client.callTool({ name: "add_usage", arguments: { ...base, usageType: "Phone", amount: 5, confirmed: false } });
      expect(unconfirmed.isError).toBe(true);
      const added = await client.callTool({ name: "add_usage", arguments: { ...base, usageType: "Phone", amount: 5, confirmed: true } });
      expect(added.isError).not.toBe(true);

      const payment = { ...base, amount: 10, transactionId: `mcp-${Date.now()}`, confirmed: true };
      const paid = await client.callTool({ name: "pay_bill", arguments: payment });
      expect(paid.isError).not.toBe(true);
      const duplicate = await client.callTool({ name: "pay_bill", arguments: payment });
      expect(duplicate.isError).toBe(true);
    } finally {
      await client.close();
      await mcp.close();
      await gateway.close();
      await api.close();
      if (previousGateway === undefined) delete process.env.GATEWAY_BASE_URL;
      else process.env.GATEWAY_BASE_URL = previousGateway;
    }
  });
});
