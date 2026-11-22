# Architecture

```mermaid
flowchart LR
  UI[Chat UI] -->|all REST calls| Gateway[API Gateway /gateway/v1]
  Gateway -->|agent route| Agent[Agent API / LLM Tool Orchestrator]
  Agent --> LLM[OpenAI-compatible LLM]
  Agent -->|REST tools| Gateway
  Agent -->|MCP Client over stdio| MCP[MCP Server Process]
  Gateway -->|mapped REST routes| REST[Billing REST API /api/v1]
  REST --> DB[(PostgreSQL)]
  MCP -->|pre-indexed sections| Policy[Billing Guide]
```

The API starts its MCP server as a child process on the first policy query. It communicates through the MCP SDK's stdio transport. The server indexes guide sections at startup; the agent does not perform policy search itself. The gateway is also used by the Swagger “Try it out” server URL and by the browser UI.

## Entity Relationship Diagram

```mermaid
erDiagram
  SUBSCRIBERS ||--o{ USAGE_RECORDS : has
  SUBSCRIBERS ||--o{ PAYMENTS : makes

  SUBSCRIBERS {
    varchar subscriber_no PK
    varchar display_name
  }

  USAGE_RECORDS {
    bigint id PK
    varchar subscriber_no FK
    integer month
    integer year
    varchar usage_type
    numeric amount
  }

  PAYMENTS {
    varchar transaction_id PK
    varchar subscriber_no FK
    integer month
    integer year
    numeric amount
    timestamptz created_at
  }
```

## Routes

- `GET /health`
- `GET /api/v1/bill`
- `GET /api/v1/bill/detailed` - protected
- `POST /api/v1/bill/calculate` - protected
- `POST /api/v1/usage` - protected
- `POST /api/v1/pay` - protected
- `POST /api/v1/auth/token`
- `POST /api/v1/agent/question` - protected

## Identity Rules

Subscriber numbers in private operations must match the authenticated JWT principal. Payment and usage operations require the protected route; MCP write tools require explicit `confirmed: true`, and the chat UI requires its confirmation checkbox.

## Assumptions

- `1 GB = 1,000 MB`.
- Extra usage uses ceiling rounding for started blocks.
- April 2025 is seeded for the demo subscriber.
- Payments are simulated.
- The in-memory store is a repeatable development mode; PostgreSQL is the documented Docker deployment data store.
