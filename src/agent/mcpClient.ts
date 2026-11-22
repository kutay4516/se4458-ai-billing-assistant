import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

let clientPromise: Promise<Client> | undefined;

function mcpEnvironment(): Record<string, string> {
  const names = ["GATEWAY_BASE_URL", "DEMO_SUBSCRIBER_NO", "DEMO_USERNAME", "DEMO_PASSWORD"];
  return Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name] as string]]));
}

async function getClient(): Promise<Client> {
  if (!clientPromise) {
    const client = new Client({ name: "billing-agent", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
        resolve(process.cwd(), "src", "mcp", "server.ts"),
      ],
      cwd: process.cwd(),
      env: mcpEnvironment(),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[billing-mcp] ${chunk.toString()}`));
    clientPromise = client.connect(transport).then(() => client).catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
}

export async function searchBillingDocumentation(query: string): Promise<string> {
  const client = await getClient();
  const result = await client.callTool({ name: "search_billing_documentation", arguments: { query } });
  if (result.isError) throw new Error("MCP_POLICY_SEARCH_FAILED");
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.flatMap((item) => item.type === "text" && item.text ? [item.text] : []).join("\n");
}

export async function closeBillingMcpClient(): Promise<void> {
  const current = clientPromise;
  clientPromise = undefined;
  if (current) {
    try {
      await (await current).close();
    } catch {
      // Closing an MCP child that failed during startup is already complete.
    }
  }
}
