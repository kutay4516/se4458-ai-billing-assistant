// One-command deployment to Azure Container Apps:  npm run deploy:azure   (Windows: double-click deploy-azure.bat)
//
//   billing-api      external ingress by default (see --internal-api): the gateway calls it over its public HTTPS address
//   billing-mcp      external ingress   (/mcp, /health)
//   billing-gateway  external ingress   (all REST routes, Swagger UI at /docs)
//   billing-agent    external ingress   (chat UI + agent endpoint; its REST calls go through the gateway)
//
// All four run the same image built in Azure (az acr build: no local Docker needed; falls back to local Docker + push when ACR Tasks is blocked, e.g. Azure for Students). The database is the DATABASE_URL from .env
// (Neon / any managed PostgreSQL). Secrets are read from .env, stored as Container Apps secrets and are never printed or written to disk.
// Existing apps with these names (a previous deployment) are updated in place; otherwise a resource group, environment and registry are created.
//
// Options:  --resource-group <rg>  --location <region, default westeurope>  --env <containerapp environment>  --skip-build  --local-build  --internal-api  --skip-verify
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const isWin = process.platform === "win32";
const AZ = process.env.AZ_BIN ?? "az";
const SCHEME = process.env.DEPLOY_SCHEME ?? "https"; // test hook only
const flag = (name) => process.argv.includes(`--${name}`);
const opt = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const secretsInUse = [];
const redact = (text) => secretsInUse.reduce((t, s) => (s && s.length >= 6 ? String(t).split(s).join("[REDACTED]") : t), String(text));
const say = (text = "") => console.log(redact(text));
const die = (text) => { console.error(`\nERROR: ${redact(text)}`); process.exit(1); };

// ---- az helper -----------------------------------------------------------------------------------------------------------------
// On Windows `az` is a .cmd file started through cmd.exe, where & | ^ in an argument (e.g. a PostgreSQL URL) would be taken as shell
// syntax. Every argument is therefore wrapped in double quotes there; values containing " or % cannot be quoted safely and are rejected.
const quote = (a) => {
  if (!isWin) return a;
  if (/["%]/.test(a)) die("an argument contains a double quote or a percent sign, which cannot be passed safely to az.cmd");
  return `"${a}"`;
};
function az(args, { json = false, tsv = false, inherit = false, allowFail = false } = {}) {
  const full = tsv ? [...args, "-o", "tsv"] : json ? [...args, "-o", "json"] : args;
  const result = spawnSync(AZ, full.map(quote), {
    shell: isWin, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", AZURE_CORE_COLLECT_TELEMETRY: "false" },
  });
  if (result.error) die(`could not run "${AZ}": ${result.error.message}. Install the Azure CLI: https://aka.ms/installazurecliwindows`);
  if (result.status !== 0) {
    if (allowFail) return null;
    die(`az ${args.slice(0, 3).join(" ")} failed (exit ${result.status})\n${redact((result.stderr ?? "").trim().slice(-1500))}`);
  }
  const out = (result.stdout ?? "").trim();
  return json ? (out ? JSON.parse(out) : null) : out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const note = (name, ok, detail = "") => { steps.push({ name, ok, detail: redact(detail) }); say(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -  " + detail : ""}`); };

// ---- 0. preconditions ----------------------------------------------------------------------------------------------------------
say("== 0/6 checking .env and the Azure CLI ==");
const env = process.env;
for (const k of ["JWT_SECRET", "DATABASE_URL", "DEMO_PASSWORD", "LLM_API_KEY"]) if (!env[k]) die(`${k} is missing in .env`);
if (env.JWT_SECRET.length < 16) die("JWT_SECRET must be at least 16 characters");
if (!/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) die("DATABASE_URL must be a postgresql:// URL");
// Shared secret between the gateway and the billing API (the API refuses requests without it). Derived from JWT_SECRET unless GATEWAY_SHARED_SECRET is set.
const gatewayKey = env.GATEWAY_SHARED_SECRET || createHmac("sha256", env.JWT_SECRET).update("billing-gateway-shared-secret").digest("hex");
secretsInUse.push(env.JWT_SECRET, env.DATABASE_URL, env.DEMO_PASSWORD, env.LLM_API_KEY, gatewayKey);
try { secretsInUse.push(decodeURIComponent(new URL(env.DATABASE_URL).password)); } catch { /* ignore */ }
if (!existsSync("Dockerfile") || !existsSync("Mobile_Provider_Billing_Guide.md")) die("run this from the project folder (Dockerfile / Mobile_Provider_Billing_Guide.md not found)");

if (az(["version"], { allowFail: true }) === null) die("the Azure CLI (az) is not installed or not on PATH. Install it from https://aka.ms/installazurecliwindows and open a new terminal.");
let account = az(["account", "show"], { json: true, allowFail: true });
if (!account) {
  say("Not signed in to Azure. A browser window will open for az login ...");
  az(["login"], { inherit: true });
  account = az(["account", "show"], { json: true });
}
say(`Azure subscription: ${account.name} (${account.user?.name ?? "user"})`);

for (const ns of ["Microsoft.App", "Microsoft.OperationalInsights", "Microsoft.ContainerRegistry"]) az(["provider", "register", "--namespace", ns, "--wait"]);

// ---- 1. resource group / environment (reuse a previous deployment when found) ----------------------------------------------------
say("\n== 1/6 resource group, environment, registry ==");
const APP_NAMES = ["billing-api", "billing-mcp", "billing-gateway", "billing-agent"];
const existing = az(["containerapp", "list", "--query", "[?" + APP_NAMES.map((n) => `name=='${n}'`).join(" || ") + "].{name:name,rg:resourceGroup,env:properties.environmentId}"], { json: true }) ?? [];
let rg = opt("resource-group", existing[0]?.rg ?? "rg-se4458-billing");
let envName = opt("env", existing[0]?.env?.split("/").pop() ?? "billing-env");
const location = opt("location", "westeurope");
const existingNames = new Set(existing.filter((a) => a.rg?.toLowerCase() === rg.toLowerCase()).map((a) => a.name));
say(existingNames.size ? `Found a previous deployment in resource group ${rg} (${[...existingNames].join(", ")}): it will be updated in place.` : "No previous deployment found: creating new resources.");

if (az(["group", "exists", "--name", rg], { tsv: true }) !== "true") az(["group", "create", "--name", rg, "--location", location]);
const envs = az(["containerapp", "env", "list", "--resource-group", rg, "--query", "[].name"], { json: true }) ?? [];
if (!envs.includes(envName)) {
  if (envs.length && !opt("env")) envName = envs[0];
  else { say(`Creating Container Apps environment ${envName} (a minute or two) ...`); az(["containerapp", "env", "create", "--name", envName, "--resource-group", rg, "--location", location]); }
}
const domain = az(["containerapp", "env", "show", "--name", envName, "--resource-group", rg, "--query", "properties.defaultDomain"], { tsv: true });
if (!domain) die("could not read the environment's default domain");

let acr = az(["acr", "list", "--resource-group", rg, "--query", "[0].name"], { tsv: true });
if (!acr) {
  const subId = az(["account", "show", "--query", "id"], { tsv: true });
  acr = `billingacr${createHash("sha1").update(subId + rg).digest("hex").slice(0, 8)}`;
  say(`Creating container registry ${acr} ...`);
  az(["acr", "create", "--name", acr, "--resource-group", rg, "--sku", "Basic", "--admin-enabled", "true", "--location", location]);
} else {
  az(["acr", "update", "--name", acr, "--admin-enabled", "true"]);
}
const loginServer = `${acr}.azurecr.io`;
const cred = az(["acr", "credential", "show", "--name", acr, "--query", "{u:username,p:passwords[0].value}"], { json: true });
secretsInUse.push(cred.p);
note("Resource group / environment / registry ready", true, `${rg} / ${envName} / ${acr} (${domain})`);

// ---- 2. image --------------------------------------------------------------------------------------------------------------------
const tag = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const image = `${loginServer}/billing:${tag}`;
say("\n== 2/6 building the image in Azure (az acr build, several minutes) ==");
const docker = (args, input) => spawnSync(process.env.DOCKER_BIN ?? "docker", args, { encoding: "utf8", input, stdio: [input ? "pipe" : "ignore", "inherit", "inherit"] });
function buildLocally() {
  // Fallback for subscriptions where ACR Tasks is blocked (e.g. Azure for Students): build with local Docker and push to the same registry.
  if (docker(["version", "--format", "{{.Server.Version}}"]).status !== 0) die("ACR Tasks is not permitted for this subscription and local Docker is not available. Start Docker Desktop and run the command again.");
  say("ACR Tasks is not available: building with local Docker and pushing to the registry ...");
  if (docker(["login", loginServer, "--username", cred.u, "--password-stdin"], cred.p).status !== 0) die("docker login to the registry failed");
  if (docker(["build", "--platform", "linux/amd64", "-t", image, "."]).status !== 0) die("docker build failed");
  if (docker(["push", image]).status !== 0) die("docker push failed");
}
if (flag("skip-build")) say("(--skip-build: reusing the image already deployed to billing-api)");
else if (flag("local-build")) buildLocally();
else if (az(["acr", "build", "--registry", acr, "--image", `billing:${tag}`, "--file", "Dockerfile", "."], { inherit: true, allowFail: true }) === null) buildLocally();
const currentImage = flag("skip-build") ? az(["containerapp", "show", "--name", "billing-api", "--resource-group", rg, "--query", "properties.template.containers[0].image"], { tsv: true, allowFail: true }) : null;
const imageRef = flag("skip-build") ? (currentImage || `${loginServer}/billing:latest`) : image;
note("Image built", true, imageRef);

// ---- 3. apps ---------------------------------------------------------------------------------------------------------------------
say("\n== 3/6 deploying the four services ==");
const common = { NODE_ENV: "production" };
const fqdnOf = (name) => az(["containerapp", "show", "--name", name, "--resource-group", rg, "--query", "properties.configuration.ingress.fqdn"], { tsv: true });
const agentFqdnGuess = `billing-agent.${domain}`;
const urls = {};

function deploy(def) {
  const secretArgs = Object.entries(def.secrets ?? {}).map(([k, v]) => `${k}=${v}`);
  const envArgs = [...Object.entries({ ...common, ...def.env }).map(([k, v]) => `${k}=${v}`), ...Object.entries(def.secretEnv ?? {}).map(([k, v]) => `${k}=secretref:${v}`)];
  const sizing = ["--cpu", "0.25", "--memory", "0.5Gi", "--min-replicas", "1", "--max-replicas", "1"]; // one replica: rate limits and sessions are in-memory
  const run = ["--command", "node", "--args", def.entry];
  if (existingNames.has(def.name)) {
    az(["containerapp", "registry", "set", "--name", def.name, "--resource-group", rg, "--server", loginServer, "--username", cred.u, "--password", cred.p]);
    if (secretArgs.length) az(["containerapp", "secret", "set", "--name", def.name, "--resource-group", rg, "--secrets", ...secretArgs]);
    az(["containerapp", "ingress", "update", "--name", def.name, "--resource-group", rg, "--type", def.ingress, "--target-port", String(def.port)]);
    az(["containerapp", "update", "--name", def.name, "--resource-group", rg, "--image", imageRef, ...run, "--replace-env-vars", ...envArgs, ...sizing]);
  } else {
    az(["containerapp", "create", "--name", def.name, "--resource-group", rg, "--environment", envName, "--image", imageRef,
      "--registry-server", loginServer, "--registry-username", cred.u, "--registry-password", cred.p,
      "--target-port", String(def.port), "--ingress", def.ingress, ...run,
      ...(secretArgs.length ? ["--secrets", ...secretArgs] : []), "--env-vars", ...envArgs, ...sizing]);
  }
  // An internal app is reached at <name>.internal.<domain>; after switching an existing app from external to internal Azure may still report the old external name.
  const reported = fqdnOf(def.name);
  urls[def.name] = def.ingress === "internal" && !/\.internal\./.test(reported) ? reported.replace(`${def.name}.`, `${def.name}.internal.`) : reported;
  note(`Deployed ${def.name}`, true, `${def.ingress}: ${urls[def.name]}`);
}

// Internal ingress is cleaner, but on "express" Container Apps environments (e.g. Azure for Students) the internal address presents a certificate that does not match
// and allowInsecure is not supported, so the gateway cannot call it. Default to a public address (JWT is still required); pass --internal-api to try internal.
const apiIngress = flag("internal-api") ? "internal" : "external";
deploy({ name: "billing-api", port: 3000, entry: "dist/api/main.js", ingress: apiIngress,
  secrets: { jwt: env.JWT_SECRET, dbu: env.DATABASE_URL, demo: env.DEMO_PASSWORD, gwk: gatewayKey },
  env: { PORT: "3000", SEED_DEMO_DATA: "true" }, secretEnv: { JWT_SECRET: "jwt", DATABASE_URL: "dbu", DEMO_PASSWORD: "demo", GATEWAY_SHARED_SECRET: "gwk" } });
deploy({ name: "billing-mcp", port: 3002, entry: "dist/mcp/main.js", ingress: "external", env: { MCP_PORT: "3002", MCP_TRANSPORT: "http" } });
deploy({ name: "billing-gateway", port: 3001, entry: "dist/gateway/main.js", ingress: "external",
  secrets: { jwt: env.JWT_SECRET, gwk: gatewayKey },
  env: { GATEWAY_PORT: "3001", BILLING_API_URL: `https://${urls["billing-api"]}`, AGENT_URL: `https://${agentFqdnGuess}` }, secretEnv: { JWT_SECRET: "jwt", GATEWAY_SHARED_SECRET: "gwk" } });
deploy({ name: "billing-agent", port: 3003, entry: "dist/agent/main.js", ingress: "external",
  secrets: { jwt: env.JWT_SECRET, llm: env.LLM_API_KEY },
  env: { AGENT_PORT: "3003", GATEWAY_URL: `https://${urls["billing-gateway"]}`, GATEWAY_PUBLIC_URL: `https://${urls["billing-gateway"]}`, MCP_URL: `https://${urls["billing-mcp"]}/mcp`,
    LLM_API_BASE_URL: env.LLM_API_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai", LLM_MODEL: env.LLM_MODEL ?? "gemini-3.5-flash" },
  secretEnv: { JWT_SECRET: "jwt", LLM_API_KEY: "llm" } });

if (urls["billing-agent"] !== agentFqdnGuess) {
  say(`The agent's real address (${urls["billing-agent"]}) differs from the one given to the gateway (${agentFqdnGuess}); updating the gateway ...`);
  az(["containerapp", "update", "--name", "billing-gateway", "--resource-group", rg, "--set-env-vars", `AGENT_URL=https://${urls["billing-agent"]}`]);
}

// ---- 4. verification through the public URLs --------------------------------------------------------------------------------------
const gw = `${SCHEME}://${urls["billing-gateway"]}`;
const mcp = `${SCHEME}://${urls["billing-mcp"]}`;
const agent = `${SCHEME}://${urls["billing-agent"]}`;
async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let body = text; try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, text };
}
if (!flag("skip-verify")) {
  say("\n== 4/6 waiting for the services and checking them through the public URLs ==");
  const expectService = async (label, url, service) => {
    let last = "no answer";
    for (let i = 0; i < 40; i++) {
      try { const r = await getJson(url); if (r.status === 200 && r.body?.service === service) return note(label, true, url); last = `HTTP ${r.status}`; } catch (e) { last = e.message; }
      await sleep(8000);
    }
    note(label, false, `${url}: ${last}`);
  };
  await expectService("API Gateway /health", `${gw}/health`, "api-gateway");
  await expectService("MCP server /health", `${mcp}/health`, "billing-mcp");
  await expectService("Agent /health", `${agent}/health`, "billing-agent");

  try {
    const ui = await getJson(`${gw}/docs`);
    const spec = await getJson(`${gw}/docs/json`);
    note("Swagger UI through the gateway (/docs)", ui.status === 200 && /swagger/i.test(ui.text) && Object.keys(spec.body?.paths ?? {}).length >= 6, `${gw}/docs (${Object.keys(spec.body?.paths ?? {}).length} documented paths)`);
    const routes = await getJson(`${gw}/gateway/routes`);
    note("Gateway route table", routes.status === 200 && routes.body?.routes?.length > 0, `${routes.body?.routes?.length ?? 0} routes`);
    const denied = await getJson(`${gw}/api/v1/bill/detailed?subscriberNo=1001&month=10&year=2026`);
    note("Protected route without token -> 401", denied.status === 401 && denied.body?.error?.code === "UNAUTHORIZED", `HTTP ${denied.status}`);
    const login = await getJson(`${gw}/api/v1/auth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscriberNo: "1001", password: env.DEMO_PASSWORD }) });
    note("Login through the gateway (database + seed data)", login.status === 200 && !!login.body?.token, `HTTP ${login.status}`);
    if (login.body?.token) {
      const detailed = await getJson(`${gw}/api/v1/bill/detailed?subscriberNo=1001&month=10&year=2026`, { headers: { authorization: `Bearer ${login.body.token}` } });
      note("Protected route with JWT -> 200", detailed.status === 200 && detailed.body?.bill?.total === 100, `HTTP ${detailed.status}, October 2026 total ${detailed.body?.bill?.total}`);
    }
    const bill = await getJson(`${gw}/api/v1/bill?subscriberNo=1001&month=10&year=2026`);
    note("Public Query Bill through the gateway", bill.status === 200, `HTTP ${bill.status}`);
    if (apiIngress === "external") {
      const direct = await getJson(`${SCHEME}://${urls["billing-api"]}/api/v1/bill?subscriberNo=1001&month=10&year=2026`);
      note("Billing API called directly (bypassing the gateway) -> 403", direct.status === 403 && direct.body?.error?.code === "GATEWAY_REQUIRED", `HTTP ${direct.status}`);
    }
  } catch (e) { note("Gateway checks", false, e.message); }
}

// ---- 5. evidence file ------------------------------------------------------------------------------------------------------------
mkdirSync("docs/evidence", { recursive: true });
const report = `# Cloud deployment (Azure Container Apps)

Deployed ${new Date().toISOString()} - resource group \`${rg}\`, environment \`${envName}\`, registry \`${acr}\`, image \`${imageRef.replace(loginServer + "/", "")}\`.

| Service | Ingress | URL |
|---|---|---|
| API Gateway (all REST routes) | external | ${gw} |
| Swagger UI (through the gateway) | external | ${gw}/docs |
| Gateway route table | external | ${gw}/gateway/routes |
| MCP server | external | ${mcp}/mcp (health: ${mcp}/health) |
| Agent + chat UI | external | ${agent} |
| Billing REST API (called by the gateway; JWT required) | ${apiIngress} | https://${urls["billing-api"]} |
| Database | managed PostgreSQL (Neon), connection string kept as a Container Apps secret | - |

Demo login: subscriber \`1001\` / \`1002\`, password = the \`DEMO_PASSWORD\` configured for this deployment (see the project README).

## Checks run by scripts/deploy-azure.mjs

${steps.map((s) => `- ${s.ok ? "PASS" : "FAIL"}: ${s.name}${s.detail ? " - " + s.detail : ""}`).join("\n")}
`;
writeFileSync("docs/evidence/deployment.md", report);

say("\n== 5/6 summary ==");
say(`API Gateway      ${gw}`);
say(`Swagger UI       ${gw}/docs`);
say(`MCP server       ${mcp}/mcp`);
say(`Agent + chat UI  ${agent}`);
say(`Billing API      https://${urls["billing-api"]}  (${apiIngress})`);
say("\nEvidence written to docs/evidence/deployment.md");
say(`\n== 6/6 ${steps.every((s) => s.ok) ? "all checks passed" : "SOME CHECKS FAILED - see the FAIL lines above"} ==`);
process.exit(steps.every((s) => s.ok) ? 0 : 1);
