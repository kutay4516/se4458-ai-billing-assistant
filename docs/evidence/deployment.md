# Cloud deployment (Azure Container Apps)

Deployed 2026-11-22T17:42:25.944Z - resource group `se4458-billing-rg`, environment `se4458-env`, registry `se4458billingkutay`, image `billing:20261122171325`.

| Service | Ingress | URL |
|---|---|---|
| API Gateway (all REST routes) | external | https://billing-gateway.redfield-d0ef7041.spaincentral.azurecontainerapps.io |
| Swagger UI (through the gateway) | external | https://billing-gateway.redfield-d0ef7041.spaincentral.azurecontainerapps.io/docs |
| Gateway route table | external | https://billing-gateway.redfield-d0ef7041.spaincentral.azurecontainerapps.io/gateway/routes |
| MCP server | external | https://billing-mcp.redfield-d0ef7041.spaincentral.azurecontainerapps.io/mcp (health: https://billing-mcp.redfield-d0ef7041.spaincentral.azurecontainerapps.io/health) |
| Agent + chat UI | external | https://billing-agent.redfield-d0ef7041.spaincentral.azurecontainerapps.io |
| Billing REST API (called by the gateway; JWT required) | external | https://billing-api.redfield-d0ef7041.spaincentral.azurecontainerapps.io |
| Database | managed PostgreSQL (Neon), connection string kept as a Container Apps secret | - |

Demo login: subscriber `1001` / `1002`, password = the `DEMO_PASSWORD` configured for this deployment (see the project README).

## Checks run by scripts/deploy-azure.mjs

- PASS: Resource group / environment / registry ready - se4458-billing-rg / se4458-env / se4458billingkutay (redfield-d0ef7041.spaincentral.azurecontainerapps.io)
- PASS: Image built - se4458billingkutay.azurecr.io/billing:20261122171325
- PASS: Deployed billing-api - external: billing-api.redfield-d0ef7041.spaincentral.azurecontainerapps.io
- PASS: Deployed billing-mcp - external: billing-mcp.redfield-d0ef7041.spaincentral.azurecontainerapps.io
- PASS: Deployed billing-gateway - external: billing-gateway.redfield-d0ef7041.spaincentral.azurecontainerapps.io
- PASS: Deployed billing-agent - external: billing-agent.redfield-d0ef7041.spaincentral.azurecontainerapps.io
- PASS: API Gateway /health - https://billing-gateway.redfield-d0ef7041.spaincentral.azurecontainerapps.io/health
- PASS: MCP server /health - https://billing-mcp.redfield-d0ef7041.spaincentral.azurecontainerapps.io/health
- PASS: Agent /health - https://billing-agent.redfield-d0ef7041.spaincentral.azurecontainerapps.io/health
- PASS: Swagger UI through the gateway (/docs) - https://billing-gateway.redfield-d0ef7041.spaincentral.azurecontainerapps.io/docs (6 documented paths)
- PASS: Gateway route table - 10 routes
- PASS: Protected route without token -> 401 - HTTP 401
- PASS: Login through the gateway (database + seed data) - HTTP 200
- PASS: Protected route with JWT -> 200 - HTTP 200, October 2026 total 100
- PASS: Public Query Bill through the gateway - HTTP 200
