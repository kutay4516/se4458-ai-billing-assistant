import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BillingStore } from "../src/billing/store.js";

/** Behavioural contract run against the in-memory store always, and against PostgreSQL when TEST_DATABASE_URL is set. */
export function storeContract(name: string, create: () => Promise<BillingStore>) {
  describe(`BillingStore contract: ${name}`, () => {
    let store: BillingStore;
    beforeEach(async () => {
      store = await create();
      await store.upsertSubscriber({ subscriberNo: "S1", displayName: "One", password: "pw-1" });
      await store.upsertSubscriber({ subscriberNo: "S2", displayName: "Two", password: "pw-2" });
    });

    afterEach(async () => { await store.close(); });

    it("verifies credentials and rejects wrong or unknown ones", async () => {
      expect(await store.verifyCredentials("S1", "pw-1")).toBe(true);
      expect(await store.verifyCredentials("S1", "pw-2")).toBe(false);
      expect(await store.verifyCredentials("nobody", "pw-1")).toBe(false);
    });

    it("addUsage adds 10 minutes of phone or 1 MB of internet per call", async () => {
      expect(await store.addUsage({ subscriberNo: "S1", month: 1, year: 2026, usageType: "Phone" })).toMatchObject({ added: 10, unit: "minutes" });
      expect(await store.addUsage({ subscriberNo: "S1", month: 1, year: 2026, usageType: "Internet" })).toMatchObject({ added: 1, unit: "MB" });
      const bill = await store.calculateBill("S1", 1, 2026);
      expect(bill).toMatchObject({ phoneMinutes: 10, internetMb: 1, total: 50 });
    });

    it("addUsage / calculateBill reject unknown subscribers", async () => {
      await expect(store.addUsage({ subscriberNo: "ghost", month: 1, year: 2026, usageType: "Phone" })).rejects.toMatchObject({ code: "SUBSCRIBER_NOT_FOUND" });
      await expect(store.calculateBill("ghost", 1, 2026)).rejects.toMatchObject({ code: "SUBSCRIBER_NOT_FOUND" });
    });

    it("calculateBill persists a snapshot and recalculation picks up new usage", async () => {
      await store.addUsage({ subscriberNo: "S1", month: 2, year: 2026, usageType: "Phone", amount: 1200 });
      expect(await store.getBill("S1", 2, 2026)).toBeNull();
      expect((await store.calculateBill("S1", 2, 2026)).total).toBe(60);
      await store.addUsage({ subscriberNo: "S1", month: 2, year: 2026, usageType: "Phone", amount: 1000 });
      expect((await store.getBill("S1", 2, 2026))!.total).toBe(60); // snapshot unchanged until recalculated
      expect((await store.calculateBill("S1", 2, 2026)).total).toBe(70);
    });

    it("keeps bills of different subscribers and months apart", async () => {
      await store.addUsage({ subscriberNo: "S1", month: 3, year: 2026, usageType: "Phone", amount: 5000 });
      await store.calculateBill("S1", 3, 2026);
      await store.calculateBill("S2", 3, 2026);
      expect((await store.getBill("S1", 3, 2026))!.phoneCharge).toBe(40);
      expect((await store.getBill("S2", 3, 2026))!.phoneCharge).toBe(0);
    });

    it("pays partially then fully, tracking balance and status", async () => {
      await store.addUsage({ subscriberNo: "S1", month: 4, year: 2026, usageType: "Phone", amount: 2500 }); // total 70
      await store.calculateBill("S1", 4, 2026);
      const partial = await store.payBill({ subscriberNo: "S1", month: 4, year: 2026, amount: 20.25, transactionId: "t1" });
      expect(partial.bill).toMatchObject({ paidAmount: 20.25, remainingBalance: 49.75, status: "PARTIAL" });
      const full = await store.payBill({ subscriberNo: "S1", month: 4, year: 2026, amount: 49.75, transactionId: "t2" });
      expect(full.bill).toMatchObject({ remainingBalance: 0, status: "PAID" });
    });

    it("rejects duplicate transaction ids, overpayment, payment on a paid bill and missing bills", async () => {
      await store.calculateBill("S1", 5, 2026); // $50
      await store.payBill({ subscriberNo: "S1", month: 5, year: 2026, amount: 10, transactionId: "dup" });
      await expect(store.payBill({ subscriberNo: "S1", month: 5, year: 2026, amount: 10, transactionId: "dup" })).rejects.toMatchObject({ code: "DUPLICATE_TRANSACTION", httpStatus: 409 });
      await expect(store.payBill({ subscriberNo: "S1", month: 5, year: 2026, amount: 40.01, transactionId: "over" })).rejects.toMatchObject({ code: "PAYMENT_EXCEEDS_BALANCE", httpStatus: 422 });
      expect((await store.getBill("S1", 5, 2026))!.paidAmount).toBe(10); // rejected attempts leave the balance untouched
      await store.payBill({ subscriberNo: "S1", month: 5, year: 2026, amount: 40, transactionId: "rest" });
      await expect(store.payBill({ subscriberNo: "S1", month: 5, year: 2026, amount: 1, transactionId: "late" })).rejects.toMatchObject({ code: "NO_BALANCE_DUE" });
      await expect(store.payBill({ subscriberNo: "S1", month: 6, year: 2026, amount: 1, transactionId: "nobill" })).rejects.toMatchObject({ code: "BILL_NOT_FOUND", httpStatus: 404 });
    });

    it("rejects a duplicate transaction id even when it belongs to another subscriber", async () => {
      await store.calculateBill("S1", 7, 2026);
      await store.calculateBill("S2", 7, 2026);
      await store.payBill({ subscriberNo: "S1", month: 7, year: 2026, amount: 5, transactionId: "shared" });
      await expect(store.payBill({ subscriberNo: "S2", month: 7, year: 2026, amount: 5, transactionId: "shared" })).rejects.toMatchObject({ code: "DUPLICATE_TRANSACTION" });
    });

    it("serialises concurrent payments reusing one transaction id (exactly one wins)", async () => {
      await store.calculateBill("S1", 8, 2026);
      const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => store.payBill({ subscriberNo: "S1", month: 8, year: 2026, amount: 5, transactionId: "race" })));
      expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
      expect((await store.getBill("S1", 8, 2026))!.paidAmount).toBe(5);
    });

    it("never lets concurrent payments overshoot the balance", async () => {
      await store.calculateBill("S1", 9, 2026); // $50
      const attempts = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => store.payBill({ subscriberNo: "S1", month: 9, year: 2026, amount: 20, transactionId: `c${i}` })));
      expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(2);
      expect((await store.getBill("S1", 9, 2026))!.remainingBalance).toBe(10);
    });

    it("pages usage records in the detailed bill", async () => {
      for (let i = 0; i < 25; i += 1) await store.addUsage({ subscriberNo: "S1", month: 10, year: 2026, usageType: "Phone" });
      await store.calculateBill("S1", 10, 2026);
      const first = await store.getBillDetailed("S1", 10, 2026, { page: 1, pageSize: 10 });
      expect(first!.usage).toMatchObject({ totalItems: 25, totalPages: 3, page: 1, pageSize: 10 });
      expect(first!.usage.items).toHaveLength(10);
      const last = await store.getBillDetailed("S1", 10, 2026, { page: 3, pageSize: 10 });
      expect(last!.usage.items).toHaveLength(5);
      const beyond = await store.getBillDetailed("S1", 10, 2026, { page: 9, pageSize: 10 });
      expect(beyond!.usage.items).toHaveLength(0);
      expect(await store.getBillDetailed("S1", 11, 2026, { page: 1, pageSize: 10 })).toBeNull();
    });
  });
}
