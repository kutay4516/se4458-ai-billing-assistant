# Architecture

Four independently runnable services plus PostgreSQL. **The LLM never calls a backend itself**: it only chooses tools; the
agent executes them (MCP client for documentation, REST through the API Gateway for live data) and returns the results to the LLM.

```mermaid
flowchart LR
  UI["Chat UI / client"] -->|"POST /api/v1/agent/chat (JWT)"| GW
  subgraph Gateway path - all REST operations
    GW["API Gateway :3001<br/>JWT check, rate limit, route map, error envelope"]
    GW -->|"/api/v1/auth, bill, usage, pay"| API["Billing REST API :3000<br/>Fastify + Swagger"]
    API --> DB[("PostgreSQL")]
  end
  GW -->|"/api/v1/agent/chat"| AGENT
  AGENT["AI Agent :3003<br/>tool-calling loop, confirmation gate"] <-->|"tool selection + answer"| LLM["LLM provider<br/>(OpenAI-compatible)"]
  AGENT -->|"REST tool calls with the user's JWT"| GW
  subgraph MCP path - separate from the gateway
    AGENT -->|"MCP client (Streamable HTTP)"| MCP["MCP Server :3002<br/>search_billing_documentation"]
    MCP --> IDX[("In-memory BM25 index<br/>built once at start")]
  end
  IDX -.->|"indexed from"| GUIDE["Mobile_Provider_Billing_Guide.md"]
```

## Agent execution workflow

```mermaid
sequenceDiagram
  participant U as User
  participant G as API Gateway
  participant A as AI Agent
  participant L as LLM
  participant M as MCP Server
  participant R as Billing REST API
  U->>G: POST /api/v1/agent/chat {message} + JWT
  G->>G: verify JWT, rate-limit by subscriber
  G->>A: forward
  A->>L: system prompt (identity fixed from JWT) + message + tool schemas
  L-->>A: tool_calls [query_bill_detailed, search_billing_documentation]
  A->>G: GET /api/v1/bill/detailed (user's JWT, subscriberNo from JWT)
  G->>R: proxied
  R-->>A: bill + usage + payments
  A->>M: MCP tools/call search_billing_documentation
  M-->>A: excerpts + section references
  A->>L: tool results
  L-->>A: grounded answer citing sections
  A-->>U: answer + tool trace
```

### Payment confirmation gate (enforced in code)

```mermaid
sequenceDiagram
  participant U as User
  participant A as AI Agent
  participant L as LLM
  participant R as Billing REST API (via gateway)
  U->>A: "Pay $20 of my October bill"
  A->>L: message + tools
  L-->>A: tool_call pay_bill {month, year, amount}
  A->>R: GET /api/v1/bill (pre-check only)
  A-->>L: {status: CONFIRMATION_REQUIRED}  (Pay Bill NOT called; action staged, 5 min TTL)
  L-->>U: "Please confirm paying $20"
  U->>A: "Yes, confirm" (or UI button with actionId)
  A->>R: POST /api/v1/pay {transactionId: AGENT-uuid}
  R-->>A: SUCCESS, remaining balance
  A->>L: payment result
  L-->>U: "Paid $20, remaining $80"
```

Any other user message cancels the staged payment. Staged actions are keyed by authenticated subscriber + conversation id, so another
user cannot confirm them.

## Entity relationship diagram

```mermaid
erDiagram
  SUBSCRIBERS ||--o{ USAGE_RECORDS : "records"
  SUBSCRIBERS ||--o{ BILLS : "is billed"
  SUBSCRIBERS ||--o{ PAYMENTS : "makes"
  BILLS ||--o{ PAYMENTS : "settled by (subscriber_no, month, year)"

  SUBSCRIBERS {
    varchar subscriber_no PK
    varchar display_name
    text password_hash "scrypt, salted"
  }
  USAGE_RECORDS {
    bigserial id PK
    varchar subscriber_no FK
    int month
    int year
    varchar usage_type "Phone | Internet"
    numeric amount "minutes or MB"
    timestamptz recorded_at
  }
  BILLS {
    bigserial id PK
    varchar subscriber_no FK "UNIQUE with month, year"
    int month
    int year
    numeric phone_minutes
    numeric internet_mb
    numeric phone_charge
    numeric internet_base_charge
    numeric internet_overage_charge
    numeric total
    timestamptz calculated_at
  }
  PAYMENTS {
    varchar transaction_id PK "global uniqueness = duplicate rejection"
    varchar subscriber_no FK
    int month
    int year
    numeric amount
    timestamptz created_at
  }
```
