import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BillingGuideIndex } from "./index.js";

export const SEARCH_TOOL = "search_billing_documentation";

/** Builds an MCP server (official SDK) exposing the single documentation tool over a pre-built index. */
export function createMcpServer(index: BillingGuideIndex): McpServer {
  const server = new McpServer({ name: "mobile-provider-billing-docs", version: "1.0.0" });

  server.registerTool(
    SEARCH_TOOL,
    {
      title: "Search billing documentation",
      description:
        "Full-text search over the indexed Mobile Provider Billing Guide (allowances, pricing, billing cycles, partial payments, disputes, late payments). " +
        "Returns the most relevant excerpts, each with section id, heading, document id and text (in `excerpt`). Use for policy/rule questions; it contains no customer-specific data.",
      inputSchema: {
        query: z.string().min(2).max(500).describe("Natural-language search query, e.g. 'extra internet charge per GB'"),
        maxResults: z.number().int().min(1).max(5).optional().describe("Maximum excerpts to return (default 3)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, maxResults }) => {
      const results = index.search(query, maxResults ?? 3);
      const payload = {
        query,
        document: index.source,
        documentId: index.documentId,
        resultCount: results.length,
        results,
        ...(results.length === 0 ? { note: "No relevant section found in the billing guide." } : {}),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    },
  );

  return server;
}
