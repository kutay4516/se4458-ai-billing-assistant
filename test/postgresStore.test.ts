import { describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresBillingStore } from "../src/billing/postgresStore.js";

function makePool(paidAmount = 0) {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("SELECT 1 FROM payments")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT usage_type")) return { rows: [{ usageType: "Phone", amount: 1200 }, { usageType: "Internet", amount: 35000 }], rowCount: 2 };
      if (sql.startsWith("SELECT COALESCE")) return { rows: [{ paid: paidAmount }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, statements };
}

describe("PostgreSQL payment transaction", () => {
  it("locks the billing period and commits a valid partial payment", async () => {
    const { pool, statements } = makePool();
    const store = new PostgresBillingStore(pool);
    const result = await store.payBill({ subscriberNo: "1001", month: 4, year: 2025, amount: 10, transactionId: "pg-partial" });
    expect(statements[0]).toBe("BEGIN");
    expect(statements.some((sql) => sql.startsWith("SELECT pg_advisory_xact_lock"))).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
    expect(result.bill).toMatchObject({ total: 30, paidAmount: 10, remainingBalance: 20, status: "PARTIAL" });
  });

  it("rolls back a payment that exceeds the balance", async () => {
    const { pool, statements } = makePool();
    const store = new PostgresBillingStore(pool);
    await expect(store.payBill({ subscriberNo: "1001", month: 4, year: 2025, amount: 31, transactionId: "pg-too-much" })).rejects.toThrow("PAYMENT_EXCEEDS_BALANCE");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.some((sql) => sql.startsWith("INSERT INTO payments"))).toBe(false);
  });
});
