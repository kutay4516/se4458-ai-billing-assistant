import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SEARCH_TOOL } from "../mcp/server.js";

/** MCP path (documentation). Entirely separate from the REST/gateway path. */
export interface DocsClient {
  search(query: string, maxResults?: number): Promise<unknown>;
}

/** REST path: every call goes to the API Gateway with the end user's own bearer token. */
export interface RestClient {
  call(method: "GET" | "POST", path: string, opts: { token: string; query?: Record<string, string | number>; body?: unknown }): Promise<{ status: number; body: unknown }>;
}

/** Real MCP client (official SDK). Connects lazily and reconnects once if the server went away. */
export class McpDocsClient implements DocsClient {
  private client: Client | null = null;

  constructor(private readonly transportFactory: () => Transport) {}

  static overHttp(url: string): McpDocsClient {
    return new McpDocsClient(() => new StreamableHTTPClientTransport(new URL(url)));
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: "billing-agent", version: "1.0.0" });
    await client.connect(this.transportFactory());
    this.client = client;
    return client;
  }

  async search(query: string, maxResults?: number): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const client = await this.connect();
        const result: any = await client.callTool({ name: SEARCH_TOOL, arguments: { query, ...(maxResults ? { maxResults } : {}) } });
        const text = result.content?.find((c: any) => c.type === "text")?.text;
        if (result.isError) throw new Error(text ?? "MCP tool error");
        return text ? JSON.parse(text) : { results: [] };
      } catch (error) {
        await this.client?.close().catch(() => undefined);
        this.client = null;
        if (attempt >= 1) throw error;
      }
    }
  }

  async close() { await this.client?.close(); this.client = null; }
}

export class GatewayRestClient implements RestClient {
  constructor(private readonly gatewayBase: string) {}

  async call(method: "GET" | "POST", path: string, opts: { token: string; query?: Record<string, string | number>; body?: unknown }) {
    const qs = opts.query ? `?${new URLSearchParams(Object.entries(opts.query).map(([k, v]) => [k, String(v)]))}` : "";
    const response = await fetch(`${this.gatewayBase}${path}${qs}`, {
      method,
      headers: { authorization: `Bearer ${opts.token}`, accept: "application/json", ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep raw text */ }
    return { status: response.status, body };
  }
}
