import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { searchBillingPolicy } from "../src/mcp/search.js";

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
});
