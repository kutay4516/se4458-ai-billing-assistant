import pg from "pg";
import { describe, expect, it } from "vitest";
import { MemoryBillingStore } from "../src/billing/memoryStore.js";
import { PostgresBillingStore } from "../src/billing/postgresStore.js";
import type { BillingStore } from "../src/billing/store.js";
import { seedDemoData } from "../src/billing/seed.js";

function seedSuite(name: string, make: () => Promise<BillingStore>) {
  describe(`demo seed: ${name}`, () => {
    it("is idempotent", async () => {
      const store = await make();
      await seedDemoData(store, "pw-1234567");
      await seedDemoData(store, "pw-1234567");
      const detailed = await store.getBillDetailed("1001", 10, 2026, { page: 1, pageSize: 50 });
      expect(detailed?.usage.totalItems).toBe(2);
      expect(detailed?.bill.total).toBe(100);
    });

    it("completes a period whose seeding was interrupted half way, keeping existing payments", async () => {
      const store = await make();
      await store.upsertSubscriber({ subscriberNo: "1001", displayName: "Demo", password: "pw-1234567" });
      await store.upsertSubscriber({ subscriberNo: "1002", displayName: "Demo 2", password: "pw-1234567" });
      // only the Phone record of October 2026 made it before the process was stopped; a bill was calculated and a payment made
      await store.addUsage({ subscriberNo: "1001", month: 10, year: 2026, usageType: "Phone", amount: 2300 });
      expect((await store.calculateBill("1001", 10, 2026)).total).toBe(70);
      await store.payBill({ subscriberNo: "1001", month: 10, year: 2026, amount: 20, transactionId: `pre-${name}` });

      await seedDemoData(store, "pw-1234567");

      const bill = (await store.getBill("1001", 10, 2026))!;
      expect(bill.internetMb).toBe(47_000);
      expect(bill.total).toBe(100);
      expect(bill.paidAmount).toBe(20);
      expect(bill.remainingBalance).toBe(80);
      expect((await store.getBill("1002", 10, 2026))?.total).toBe(50);
    });
  });
}

seedSuite("in-memory", async () => new MemoryBillingStore());

const url = process.env.TEST_DATABASE_URL;
if (url) {
  seedSuite("PostgreSQL", async () => {
    const pool = new pg.Pool({ connectionString: url });
    await pool.query("DROP TABLE IF EXISTS payments, bills, usage_records, subscribers CASCADE");
    const store = new PostgresBillingStore(pool);
    await store.init();
    return store;
  });
}
