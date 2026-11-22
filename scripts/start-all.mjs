// Starts the four services (API, MCP, gateway, agent) for local development: `npm run dev`
import { spawn } from "node:child_process";
import "dotenv/config";

const services = [
  ["api", "src/api/main.ts", "\x1b[36m"],
  ["mcp", "src/mcp/main.ts", "\x1b[35m"],
  ["gateway", "src/gateway/main.ts", "\x1b[33m"],
  ["agent", "src/agent/main.ts", "\x1b[32m"],
];
const children = services.map(([name, file, color]) => {
  const child = spawn("npx", ["tsx", file], { env: process.env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const prefix = (chunk) => chunk.toString().split("\n").filter(Boolean).forEach((l) => console.log(`${color}[${name}]\x1b[0m ${l.slice(0, 220)}`));
  child.stdout.on("data", prefix); child.stderr.on("data", prefix);
  child.on("exit", (code) => console.log(`[${name}] exited with ${code}`));
  return child;
});
const stop = () => children.forEach((c) => c.kill("SIGTERM"));
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
console.log("Chat UI: http://localhost:3003   Gateway: http://localhost:3001/gateway/routes   API docs: http://localhost:3000/docs");
