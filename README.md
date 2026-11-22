# Group 2 - AI Billing Support Assistant

A service-oriented midterm implementation for the mobile provider billing scenario.

See the [architecture and ER diagram](docs/architecture.md) and the [billing policy guide](Mobile_Provider_Billing_Guide.md). Copy [.env.example](.env.example) to `.env` for local configuration; keep `.env` private.

## Architecture

- Fastify TypeScript REST API behind versioned routes
- JWT subscriber authentication
- PostgreSQL schema and Docker Compose deployment
- MCP SDK server with billing and policy tools
- Credential login issuing JWTs to a subscriber identity
- LLM-ready agent endpoint with tool execution traces
- Static mobile billing chat interface
- No real money or card processing

## Billing Rules

- 1 GB = 1,000 MB.
- Phone: first 1,000 minutes are free; extra usage is charged at $10 per started 1,000-minute block.
- Internet: first 20 GB is free; extra usage is charged at $10 per started 10 GB block.
- Payments are simulated and partial payments update the remaining balance.
- Duplicate transaction IDs are rejected.

## Run Locally

```powershell
npm install
npm run dev
```

Open:

- Chat UI: http://localhost:3000/
- Swagger: http://localhost:3000/docs/
- API health: http://localhost:3000/health
- Gateway health: http://localhost:3001/health

Start the gateway in a second terminal:

```powershell
npm run gateway
```

The browser chat UI, agent, and MCP REST tools use the gateway at `http://localhost:3001/gateway/v1`. The gateway enables CORS for the local UI on port 3000. Gateway routes are listed in [Gateway and authentication contract](#gateway-and-authentication-contract).

Seed subscriber: `1001`, month `4`, year `2025`.

## Docker and PostgreSQL

```powershell
docker compose up --build
```

PostgreSQL is initialized from `migrations/001_initial.sql`. Set `DATABASE_URL` to activate `src/billing/postgresStore.ts`; otherwise the HTTP API uses an in-memory store for repeatable local tests.

## MCP Server

Start the REST API first, then run:

```powershell
npm run mcp
```

The agent starts a separate MCP stdio server process and calls it through the MCP SDK. The MCP server indexes the guide's sections once at startup and returns matching excerpts with section IDs. To connect another MCP host directly, run `npm run mcp` in its configured stdio process entry.

The server exposes:

- `search_billing_documentation`
- `calculate_bill`
- `query_bill`
- `query_bill_detailed`
- `add_usage`
- `pay_bill`

Both `add_usage` and `pay_bill` tools require `confirmed: true`. The API also rejects unconfirmed usage and payment requests, so the rule applies even when a client bypasses the chat UI or MCP tool schema.

## Authentication

Authenticate with the demo subscriber credentials:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/gateway/v1/auth/token' -ContentType 'application/json' -Body '{"subscriberNo":"1001","username":"subscriber1001","password":"change-me"}'
```

Configure `DEMO_SUBSCRIBER_NO`, `DEMO_USERNAME`, `DEMO_PASSWORD`, and `JWT_SECRET` in `.env` for deployment. Use a strong password and strong JWT secret; never commit real secrets.

Send the returned token as `Authorization: Bearer <token>` for agent, calculate, usage, detailed bill, and payment requests. Public bill summaries do not require a token.

## Demo Scenarios

1. MCP-only: ask for the internet allowance; the trace should cite `[allowances]`.
2. REST-only: query the public April 2025 bill for subscriber `1001` through the gateway.
3. Combined: ask `What is my detailed April 2025 bill and why did internet usage add a charge?`; the trace should include detailed-bill and policy-search calls.

## Test

```powershell
npm test
npm run build
```

## LLM Configuration

Set `LLM_API_KEY`, `LLM_API_BASE_URL`, and `LLM_MODEL` in `.env`. The agent route uses real OpenAI-compatible function/tool calling when `LLM_API_KEY` is present. It falls back to deterministic traceable routing for offline tests and demos. No live LLM key is required for unit tests.

## Verification Evidence

The current suite contains 25 automated tests covering Swagger rendering inputs, the generated spec, REST validation/authentication, paging, payment edges, PostgreSQL transaction behavior, gateway proxying, MCP retrieval/indexing, and tool confirmation.

Verified locally:

- API health: `GET http://localhost:3000/health`
- Gateway health: `GET http://localhost:3001/health`
- Public gateway bill: `GET http://localhost:3001/gateway/v1/bill?subscriberNo=1001&month=4&year=2025`
- Protected gateway detailed bill using a subscriber JWT
- Partial payment and duplicate transaction rejection
- Subscriber mismatch rejection
- Valid JWT login and invalid credential rejection
- Swagger HTML, CSS, JavaScript bundle, and generated OpenAPI spec
- MCP-only, REST-only, and combined agent scenarios through the gateway
- Confirmed MCP usage/payment and rejection without confirmation

## Submission Evidence Checklist

- Chat UI and tool trace screenshots
- MCP-only, REST-only, and combined agent scenario logs
- Three policy retrieval queries with one success and one no-match case
- Swagger/OpenAPI screenshot from http://localhost:3000/docs/ or the deployed docs URL
- Public gateway route evidence
- Protected gateway route with JWT evidence
- Docker Compose container status and PostgreSQL records
- Successful simulated payment and duplicate transaction rejection
- `npm test` and `npm run build` output
- Live Gemini response or test trace

## Cloud Deployment

The public deployment is hosted on Azure Container Apps:

- API: https://billing-api.redfield-d0ef7041.spaincentral.azurecontainerapps.io
- Swagger: https://billing-api.redfield-d0ef7041.spaincentral.azurecontainerapps.io/docs/
- Gateway health: https://billing-gateway.redfield-d0ef7041.spaincentral.azurecontainerapps.io/health
- Gateway OpenAPI spec: https://billing-gateway.redfield-d0ef7041.spaincentral.azurecontainerapps.io/gateway/v1/openapi.json
- Public bill: https://billing-gateway.redfield-d0ef7041.spaincentral.azurecontainerapps.io/gateway/v1/bill?subscriberNo=1001&month=4&year=2025

The API and gateway use Azure Container Apps and Neon PostgreSQL through `DATABASE_URL`. The agent starts its MCP stdio server as a separate child process from the deployed API container; a standalone stdio entry point is also available with `npm run mcp`. The images are stored in `se4458billingkutay.azurecr.io`, and secrets are supplied through Azure Container App secret references. Never commit `.env`, database passwords, JWT secrets, or API keys.

## Gateway and authentication contract

The gateway base is `http://localhost:3001/gateway/v1` locally. `GATEWAY_BASE_URL` is the server-to-server address used by the agent and MCP clients; `GATEWAY_PUBLIC_URL` is the browser and Swagger server address. For Azure, both use the [Gateway API base](https://billing-gateway.redfield-d0ef7041.spaincentral.azurecontainerapps.io/gateway/v1). The gateway forwards requests and the subscriber's `Authorization` header to the API.

| Gateway route | API route | Access |
| --- | --- | --- |
| `GET /gateway/v1/health` | `GET /health` | Public health check |
| `GET /gateway/v1/bill` | `GET /api/v1/bill` | Public summary |
| `POST /gateway/v1/auth/token` | `POST /api/v1/auth/token` | Credentials required |
| `POST /gateway/v1/agent/question` | `POST /api/v1/agent/question` | Subscriber JWT |
| `POST /gateway/v1/bill/calculate` | `POST /api/v1/bill/calculate` | Subscriber JWT |
| `GET /gateway/v1/bill/detailed` | `GET /api/v1/bill/detailed` | Subscriber JWT |
| `POST /gateway/v1/usage` | `POST /api/v1/usage` | Subscriber JWT and `confirmed: true` |
| `POST /gateway/v1/pay` | `POST /api/v1/pay` | Subscriber JWT and `confirmed: true` |

| Operation | Access |
| --- | --- |
| Public bill summary | No token; may query any subscriber number |
| Calculate bill | JWT for the requested subscriber |
| Detailed bill, usage, payment | JWT for the requested subscriber |
| Agent question | JWT for the requested subscriber |
| Add usage or pay bill | JWT plus `confirmed: true` in the request body |

`GET /api/v1/bill/detailed` accepts `page` (default `1`) and `pageSize` (default `10`, maximum `100`). Usage and payment results each return `page`, `pageSize`, `total`, and `items`. The bill object includes phone minutes, internet MB and GB, and a phone/internet charge breakdown.

Pricing follows the [provided billing guide](Mobile_Provider_Billing_Guide.md): 1 GB = 1,000 MB, the first 1,000 phone minutes and 20 GB are free, and each started extra block of 1,000 phone minutes or 10 GB costs $10. The brief's "$50 up to 20 GB" line and its sample April 2025 total of $75 conflict with the guide and the seeded 1,200-minute/35,000-MB usage; this implementation follows the guide and calculates $30 ($10 phone + $20 internet). PostgreSQL payments use a transaction and a per-subscriber/month lock so concurrent payments cannot spend the same remaining balance.

Example error response for an unauthenticated protected request:

```json
{"error":"UNAUTHORIZED"}
```

Swagger is served at `http://localhost:3000/docs/`, with generated OpenAPI JSON at `/docs/json` and static assets under `/docs/static/`. The specification points “Try it out” requests at the gateway. The deployed page is [Azure Swagger UI](https://billing-api.redfield-d0ef7041.spaincentral.azurecontainerapps.io/docs/); its static files and spec are no-store to avoid a stale empty UI after redeployment.

## MCP retrieval checks

The automated MCP tests exercise these three distinct queries:

1. `internet 20 GB allowance` — finds the allowance section.
2. `duplicate transaction payment` — finds the payment duplicate rule.
3. `xyznotapolicyword` — safely returns no matches.

Run them with `npx vitest run test/mcp.test.ts`. The complete suite remains offline and does not require Azure or a live LLM key.
