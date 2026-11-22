// Real-environment verification: checks .env, the Neon connection, the LLM key, starts the whole stack,
// runs the end-to-end demo against it and saves the evidence. Run with `npm run verify:real`
// (or double-click run-all.bat on Windows). Secrets are never printed or written to the evidence files.
import "dotenv/config";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const isWin = process.platform === "win32";
const results = [];
const secrets = [process.env.LLM_API_KEY, process.env.DATABASE_URL, process.env.JWT_SECRET].filter(Boolean);
const redact = (text) => {
  let t = String(text);
  for (const s of secrets) t = t.split(s).join("[REDACTED]");
  if (process.env.DATABASE_URL) {
    try { const pw = decodeURIComponent(new URL(process.env.DATABASE_URL).password); if (pw) t = t.split(pw).join("[REDACTED]"); } catch { /* ignore */ }
  }
  return t;
};
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail: redact(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -  " + redact(detail) : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. .env
const key = process.env.LLM_API_KEY;
record(".env: LLM_API_KEY set", !!key, key ? `length ${key.length}` : "missing");
record(".env: DATABASE_URL set (Neon/Postgres)", !!process.env.DATABASE_URL, process.env.DATABASE_URL ? "yes" : "not set -> in-memory store will be used");

// 2. Neon / Postgres reachability (read-only)
if (process.env.DATABASE_URL) {
  try {
    const pg = await import("pg");
    const client = new pg.default.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
    await client.connect();
    const v = await client.query("select current_database() as db, version() as v");
    const t = await client.query("select table_name from information_schema.tables where table_schema='public' order by 1");
    record("Neon: connection", true, `db=${v.rows[0].db}; tables: ${t.rows.map((r) => r.table_name).join(", ") || "(none yet - created on API start)"}`);
    await client.end();
  } catch (e) { record("Neon: connection", false, e.message); }
}

// 3. LLM: key, model and a tiny real chat call (the same endpoint the agent uses)
if (key) {
  const base = (process.env.LLM_API_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, "");
  const model = process.env.LLM_MODEL ?? "gemini-3.5-flash";
  let modelIds = [];
  try {
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    record("LLM: key accepted by provider", res.ok, `HTTP ${res.status}${res.ok ? "" : " (key wrong/blocked? get a new one at https://aistudio.google.com/apikey)"}`);
    if (res.ok) modelIds = ((await res.json()).data ?? []).map((m) => String(m.id).replace(/^models\//, ""));
  } catch (e) { record("LLM: provider reachable", false, e.message); }
  // The free tier has a small per-model daily quota (e.g. 20 requests/day), and quota is counted per model. If the configured
  // model cannot answer (quota used up, model retired), try lighter models for this run and say which one worked.
  const pingModel = async (m) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: m, messages: [{ role: "user", content: "Reply with the single word: pong" }] }),
      signal: AbortSignal.timeout(45000),
    });
    const text = await res.text();
    let answer = ""; try { answer = JSON.parse(text).choices?.[0]?.message?.content ?? ""; } catch { /* not json */ }
    return { ok: res.ok, status: res.status, answer: String(answer).trim().slice(0, 40), text: text.replace(/\s+/g, " ") };
  };
  const fallbacks = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-flash-lite-latest"].filter((m) => m !== model && (modelIds.length === 0 || modelIds.includes(m)));
  let working = null;
  const tried = [];
  for (const m of [model, ...fallbacks]) {
    try {
      const r = await pingModel(m);
      const why = r.status === 429 ? (/per ?day/i.test(r.text) ? "daily free-tier quota used up" : "rate limited") : r.text.slice(0, 160);
      tried.push(r.ok ? `${m}: ok (answer: ${r.answer})` : `${m}: HTTP ${r.status} ${why}`);
      if (r.ok) { working = m; break; }
    } catch (e) { tried.push(`${m}: ${e.message}`); }
  }
  record(`LLM: chat call (${working ?? model})`, !!working, tried.join(" | "));
  if (working && working !== model) {
    console.log(`      -> "${model}" is not usable right now; this run uses "${working}". Put LLM_MODEL=${working} in .env to make it permanent.`);
    process.env.LLM_MODEL = working;
  } else if (!working) {
    console.log(`      Gemini models this key can use: ${modelIds.filter((m) => /gemini/i.test(m)).slice(0, 25).join(", ") || "(none listed)"}`);
    console.log("      Every tried model failed. For a daily-quota error wait for the reset (see the retry time above), use another API key, or enable billing.");
  }
}

// 4. Pick free ports. Defaults are 3000-3003; if something else (an older server, Docker Desktop, ...) holds one of them,
//    the whole stack moves to 3100-3103 instead of fighting over the ports. Nothing is killed.
const portBusy = (port) => new Promise((resolve) => { const srv = net.createServer(); srv.once("error", () => resolve(true)); srv.once("listening", () => srv.close(() => resolve(false))); srv.listen(port, "127.0.0.1"); });
const anyBusy = async (base) => (await Promise.all([0, 1, 2, 3].map((o) => portBusy(base + o)))).some(Boolean);
let base = 3000;
if (await anyBusy(base)) { console.log("Ports 3000-3003 are not all free (an older server or Docker is using one) -> using 3100-3103 for this run."); base = 3100; }
if (await anyBusy(base)) {
  record("A free port range (3000-3003 or 3100-3103)", false, "both ranges are busy; close old `npm run dev` windows and run again");
  writeFileSync("docs/evidence/verify-real-summary.txt", results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`).join("\n") + "\n");
  process.exit(1);
}
const P = { api: base, gateway: base + 1, mcp: base + 2, agent: base + 3 };
const EXPECTED = { [P.api]: "billing-api", [P.gateway]: "api-gateway", [P.mcp]: "billing-mcp", [P.agent]: "billing-agent" };
const stackEnv = {
  ...process.env,
  PORT: String(P.api), GATEWAY_PORT: String(P.gateway), MCP_PORT: String(P.mcp), AGENT_PORT: String(P.agent),
  BILLING_API_URL: `http://127.0.0.1:${P.api}`, AGENT_URL: `http://127.0.0.1:${P.agent}`,
  GATEWAY_URL: `http://127.0.0.1:${P.gateway}`, GATEWAY_PUBLIC_URL: `http://127.0.0.1:${P.gateway}`, MCP_URL: `http://127.0.0.1:${P.mcp}/mcp`,
};
record(`Ports free: using ${P.api}-${P.agent}`, true, `api ${P.api}, gateway ${P.gateway}, mcp ${P.mcp}, agent ${P.agent}`);

// 5. Start the stack
console.log("\nStarting API, MCP, gateway and agent (the API runs migrations/seed on Neon first, this can take a minute) ...");
const stack = spawn("node", ["scripts/start-all.mjs"], { env: stackEnv, stdio: ["ignore", "pipe", "pipe"], shell: isWin, detached: !isWin });
let stackLog = "";
stack.stdout.on("data", (d) => { stackLog += d; });
stack.stderr.on("data", (d) => { stackLog += d; });
const stopStack = () => {
  if (isWin) spawnSync("taskkill", ["/PID", String(stack.pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(-stack.pid, "SIGKILL"); } catch { /* already gone */ } }
};
process.on("exit", stopStack);

const healthy = async (port) => { try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) }); return r.ok && (await r.json()).service === EXPECTED[port]; } catch { return false; } };
let up = false;
for (let i = 0; i < 90 && !up; i++) {
  await sleep(2000);
  up = (await Promise.all(Object.keys(EXPECTED).map(healthy))).every(Boolean);
}
record("Stack: all four services healthy", up, up ? `api ${P.api}, gateway ${P.gateway}, mcp ${P.mcp}, agent ${P.agent}` : `timeout after 180 s; not healthy: ${(await Promise.all(Object.keys(EXPECTED).map(async (p) => ((await healthy(p)) ? null : p)))).filter(Boolean).join(", ")}`);
const store = /in-memory store/i.test(stackLog) ? "in-memory store" : /postgres/i.test(stackLog) ? "PostgreSQL (Neon)" : "unknown (see log)";
record("API storage backend", !/in-memory/.test(store) || !process.env.DATABASE_URL, store);

// 6. End-to-end demo with the real LLM
mkdirSync("docs/evidence", { recursive: true });
if (up) {
  const e2e = spawnSync("npx", ["tsx", "scripts/e2e-demo.ts"], { env: stackEnv, encoding: "utf8", shell: isWin, timeout: 240000, maxBuffer: 20 * 1024 * 1024 });
  const transcript = redact(e2e.stdout ?? "");
  const header = `<!-- Generated by scripts/verify-real.mjs with the REAL LLM configured in .env (${process.env.LLM_MODEL ?? "default model"}). -->\n`;
  writeFileSync("docs/evidence/e2e-transcript.md", header + transcript);
  const hasContent = transcript.length > 500;
  const llmErrors = (transcript.match(/"code": "LLM_ERROR"/g) ?? []).length;
  record("E2E agent scenarios answered by the real LLM (no LLM_ERROR)", llmErrors === 0, llmErrors ? `${llmErrors} agent call(s) failed; see the "message" in docs/evidence/e2e-transcript.md` : "ok");
  record("E2E demo ran (exit code 0)", e2e.status === 0 && hasContent, `exit ${e2e.status}; ${transcript.length} chars -> docs/evidence/e2e-transcript.md`);
  if (e2e.status !== 0) console.log(redact(e2e.stderr ?? "").slice(-1500));
}

// 7. Save stack log and summary, stop everything
stopStack();
writeFileSync("docs/evidence/stack-log.txt", (() => { const l = redact(stackLog).split("\n"); return l.length > 300 ? [...l.slice(0, 100), "...", ...l.slice(-200)].join("\n") : l.join("\n"); })());
const summary = `Real-environment verification - ${new Date().toISOString()}\n\n` + results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  -  " + r.detail : ""}`).join("\n") + "\n";
writeFileSync("docs/evidence/verify-real-summary.txt", summary);
console.log(`\nSummary saved to docs/evidence/verify-real-summary.txt  (${results.filter((r) => r.ok).length}/${results.length} passed)`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
