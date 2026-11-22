import pg from "pg";
import { MemoryBillingStore } from "../src/billing/memoryStore.js";
import { PostgresBillingStore } from "../src/billing/postgresStore.js";
import { describe } from "vitest";
import { storeContract } from "./store.contract.js";

storeContract("in-memory", async () => new MemoryBillingStore());

// Real PostgreSQL contract run: TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/db npm test
const url = process.env.TEST_DATABASE_URL;
if (url) {
  storeContract("PostgreSQL", async () => {
    const pool = new pg.Pool({ connectionString: url });
    await pool.query("DROP TABLE IF EXISTS payments, bills, usage_records, subscribers CASCADE");
    const store = new PostgresBillingStore(pool);
    await store.init();
    return store;
  });
} else {
  describe.skip("BillingStore contract: PostgreSQL (set TEST_DATABASE_URL to run)", () => {});
}
