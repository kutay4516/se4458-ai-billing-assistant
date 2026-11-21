# Architecture

```mermaid
flowchart LR
  UI[Chat UI] --> Agent[Agent Orchestrator]
  Agent -->|tool selection| MCP[MCP Server]
  Agent -->|direct operations| Gateway[API Gateway / Versioned Routes]
  MCP --> Gateway
  Gateway --> REST[Billing REST API]
  REST --> DB[(PostgreSQL)]
  MCP --> Policy[Indexed Billing Guide]
```

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
- `POST /api/v1/bill/calculate`
- `POST /api/v1/usage` - protected
- `POST /api/v1/pay` - protected
- `POST /api/v1/auth/token`
- `POST /api/v1/agent/question`

## Identity Rules

Subscriber numbers in private operations must match the authenticated JWT principal. Payment and usage operations require the protected route and explicit confirmation in the agent/MCP flow.

## Assumptions

- `1 GB = 1,000 MB`.
- Extra usage uses ceiling rounding for started blocks.
- April 2025 is seeded for the demo subscriber.
- Payments are simulated.
- The in-memory store is a repeatable development mode; PostgreSQL is the documented Docker deployment data store.
