import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BillingGuideIndex } from "./index.js";
import { createMcpServer } from "./server.js";

const guidePath = path.resolve(process.cwd(), process.env.BILLING_GUIDE_PATH ?? "Mobile_Provider_Billing_Guide.md");
// Index is built once, here, before any query is served.
const index = new BillingGuideIndex(await readFile(guidePath, "utf8"), path.basename(guidePath));
const log = (...args: unknown[]) => console.error("[mcp]", ...args); // stderr: stdout is reserved for stdio transport

log(`indexed ${index.stats.chunks} chunks / ${index.stats.terms} terms from ${guidePath}`);

if ((process.env.MCP_TRANSPORT ?? "http") === "stdio") {
  await createMcpServer(index).connect(new StdioServerTransport());
  log("stdio transport ready");
} else {
  const readBody = (req: IncomingMessage) => new Promise<unknown>((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : undefined); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return send(res, 200, { status: "ok", service: "billing-mcp", index: index.stats });
    if (url.pathname !== "/mcp") return send(res, 404, { error: "Not found. MCP endpoint is POST /mcp" });
    if (req.method !== "POST") return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server, POST only)" }, id: null });
    try {
      // Stateless: a fresh protocol session per request over the shared, pre-built index.
      const server = createMcpServer(index);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    } catch (error) {
      log("request failed", error);
      if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const port = Number(process.env.MCP_PORT ?? 3002);
  http.listen(port, "0.0.0.0", () => log(`streamable HTTP transport listening on :${port}/mcp`));
}
