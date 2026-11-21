# Group 2 - AI Billing Support Assistant

A service-oriented midterm implementation for the mobile provider billing scenario.

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
- Swagger: http://localhost:3000/docs
- API health: http://localhost:3000/health
- Gateway health: http://localhost:3001/health

Start the gateway in a second terminal:

```powershell
npm run gateway
```

Gateway routes are available under `http://localhost:3001/gateway/v1/...`.

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

The server exposes:

- `search_billing_documentation`
- `calculate_bill`
- `query_bill`
- `query_bill_detailed`
- `add_usage`
- `pay_bill`

Payment tool input requires `confirmed: true`.

## Authentication

Authenticate with the demo subscriber credentials:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/v1/auth/token' -ContentType 'application/json' -Body '{"subscriberNo":"1001","username":"subscriber1001","password":"change-me"}'
```

Configure `DEMO_SUBSCRIBER_NO`, `DEMO_USERNAME`, `DEMO_PASSWORD`, and `JWT_SECRET` in `.env` for deployment. Use a strong password and strong JWT secret; never commit real secrets.

Send the returned token as `Authorization: Bearer <token>` for usage, detailed bill, and payment requests.

## Demo Scenarios

1. MCP-only: ask for extra internet charge policy.
2. REST-only: calculate or query subscriber `1001` for April 2025.
3. Combined: ask `What is my detailed April 2025 bill and why did internet usage add a charge?`

## Test

```powershell
npm test
npm run build
```

## LLM Configuration

Set `LLM_API_KEY`, `LLM_API_BASE_URL`, and `LLM_MODEL` in `.env`. The agent route uses real OpenAI-compatible function/tool calling when `LLM_API_KEY` is present. It falls back to deterministic traceable routing for offline tests and demos. No live LLM key is required for unit tests.

## Verification Evidence

The current suite contains 16 passing tests covering formulas, store payments, MCP retrieval, API operations, authentication, authorization, and agent scenario labels.

Verified locally:

- API health: `GET http://localhost:3000/health`
- Gateway health: `GET http://localhost:3001/health`
- Public gateway bill: `GET http://localhost:3001/gateway/v1/bill?subscriberNo=1001&month=4&year=2025`
- Protected gateway detailed bill using a subscriber JWT
- Partial payment and duplicate transaction rejection
- Subscriber mismatch rejection

## Cloud Deployment

The Docker configuration can be deployed to Azure Container Apps, AWS ECS, or Google Cloud Run. Use the provided PostgreSQL service or a managed PostgreSQL instance and set `DATABASE_URL` plus a strong `JWT_SECRET`.
