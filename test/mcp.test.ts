import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BillingGuideIndex, chunkMarkdown, MAX_CHUNK_CHARS } from "../src/mcp/index.js";
import { createMcpServer, SEARCH_TOOL } from "../src/mcp/server.js";

const guide = await readFile("Mobile_Provider_Billing_Guide.md", "utf8");
const index = new BillingGuideIndex(guide);

describe("guide chunking", () => {
  it("splits by heading, keeps the heading path as the section reference and ignores HTML comments", () => {
    const chunks = chunkMarkdown("<!-- hidden -->\n# Guide\n\n## 2. Pricing\n### 2.1 Phone\nfree minutes\n### 2.2 Internet\nfifty dollars\n");
    expect(chunks.map((c) => c.section)).toEqual(["Guide > 2. Pricing > 2.1 Phone", "Guide > 2. Pricing > 2.2 Internet"]);
    expect(JSON.stringify(chunks)).not.toContain("hidden");
  });
  it("splits oversized sections into bounded chunks with unique ids", () => {
    const long = "# T\n## Long\n" + Array.from({ length: 60 }, (_, i) => `- rule number ${i} about billing`).join("\n");
    const chunks = chunkMarkdown(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= MAX_CHUNK_CHARS * 1.5)).toBe(true);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });
  it("parses section numbers, headings and the document id", () => {
    expect(index.documentId).toBe("MOB-BILLING-2026-01");
    const c = chunkMarkdown("# T\n## 3. Internet\n### 3.2 Additional internet blocks\ntext\n").find((x) => x.sectionId === "3.2");
    expect(c).toMatchObject({ sectionId: "3.2", heading: "Additional internet blocks" });
  });
  it("indexes the provided guide", () => {
    expect(index.chunks.length).toBeGreaterThanOrEqual(6);
    expect(index.stats.terms).toBeGreaterThan(30);
  });
});

describe("three distinct retrieval queries (assignment requirement)", () => {
  it("Q1 'How much does extra internet cost?' -> extra data pricing sections", () => {
    const hits = index.search("How much does extra internet cost?");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.slice(0, 2).some((h) => ["8.1", "3.2"].includes(h.sectionId))).toBe(true);
    expect(hits[0]).toMatchObject({ documentId: "MOB-BILLING-2026-01", heading: expect.any(String), sectionId: expect.stringMatching(/^\d+\.\d+$/) });
    expect(hits[0]!.excerpt).toMatch(/\$10/);
    expect(hits[0]!.reference).toContain("Mobile_Provider_Billing_Guide.md §");
  });
  it("Q2 'Can I pay my bill in parts?' -> payments section", () => {
    const hits = index.search("Can I pay my bill in parts? partial payment");
    expect(hits[0]!.sectionId).toBe("5.1");
    expect(hits[0]!.heading).toBe("Full and partial payments");
    expect(hits[0]!.excerpt.toLowerCase()).toContain("partial");
  });
  it("Q3 'What if my payment is late?' -> late payments section", () => {
    const hits = index.search("what happens when I pay late, overdue balance");
    expect(["6.1", "6.2", "6.3"]).toContain(hits[0]!.sectionId);
  });
  it("Q3b 'How do I dispute a wrong bill?' -> disputes section", () => {
    expect(index.search("How do I dispute a wrong bill?")[0]!.sectionId).toMatch(/^7\./);
  });
  it("returns an empty list for unrelated text", () => {
    expect(index.search("xyzzy quantum banana")).toEqual([]);
  });
  it("is deterministic and bounded by the limit", () => {
    expect(index.search("internet", 2).length).toBeLessThanOrEqual(2);
    expect(index.search("internet")).toEqual(index.search("internet"));
  });
});

describe("indexed once, not per question", () => {
  it("many queries never rebuild or mutate the index", () => {
    const before = { builtAt: index.builtAt, chunks: index.chunks, stats: JSON.stringify(index.stats) };
    for (let i = 0; i < 200; i += 1) index.search(`internet cost ${i}`);
    expect(index.builtAt).toBe(before.builtAt);
    expect(index.chunks).toBe(before.chunks);
    expect(JSON.stringify(index.stats)).toBe(before.stats);
  });
});

describe("MCP server (official SDK) over a real client/server transport", () => {
  async function connect() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(index);
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  it("lists exactly one tool with the required name and a query schema", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search_billing_documentation"]);
    expect((tools[0]!.inputSchema as any).required).toContain("query");
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true);
  });

  it("returns excerpts with section references through tools/call", async () => {
    const client = await connect();
    const result: any = await client.callTool({ name: SEARCH_TOOL, arguments: { query: "extra internet charge" } });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.resultCount).toBeGreaterThan(0);
    expect(payload.results[0]).toMatchObject({ reference: expect.stringContaining("§"), section: expect.any(String), sectionId: expect.any(String), heading: expect.any(String), documentId: "MOB-BILLING-2026-01", excerpt: expect.any(String) });
    expect(payload).toMatchObject({ document: "Mobile_Provider_Billing_Guide.md", documentId: "MOB-BILLING-2026-01" });
  });

  it("reports no-match explicitly and rejects invalid input", async () => {
    const client = await connect();
    const none: any = await client.callTool({ name: SEARCH_TOOL, arguments: { query: "xyzzy quantum banana" } });
    expect(JSON.parse(none.content[0].text)).toMatchObject({ resultCount: 0, note: expect.any(String) });
    const bad: any = await client.callTool({ name: SEARCH_TOOL, arguments: { query: "x" } }).catch((e) => ({ isError: true, e }));
    expect(bad.isError).toBe(true);
  });
});
