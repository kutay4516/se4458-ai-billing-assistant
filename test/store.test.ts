import { describe, expect, it } from "vitest";
import { BillingStore } from "../src/billing/store.js";

describe("billing store", () => {
  it("returns seed-independent usage and detailed totals", () => {
    const store = new BillingStore();
    store.addUsage({ subscriberNo: "1001", month: 4, year: 2025, usageType: "Phone", amount: 1200 });
    const bill = store.calculateBill("1001", 4, 2025);
    expect(bill.phoneCharge).toBe(10);
    expect(bill.total).toBe(10);
  });

  it("rejects duplicate transaction IDs", () => {
    const store = new BillingStore();
    store.addUsage({ subscriberNo: "1001", month: 4, year: 2025, usageType: "Phone", amount: 1200 });
    const payment = { subscriberNo: "1001", month: 4, year: 2025, amount: 10, transactionId: "tx-1" };
    store.payBill(payment);
    expect(() => store.payBill(payment)).toThrow("DUPLICATE_TRANSACTION");
  });

  it("supports partial payment", () => {
    const store = new BillingStore();
    store.addUsage({ subscriberNo: "1001", month: 4, year: 2025, usageType: "Phone", amount: 2500 });
    const result = store.payBill({ subscriberNo: "1001", month: 4, year: 2025, amount: 10, transactionId: "tx-2" });
    expect(result.bill.remainingBalance).toBe(10);
    expect(result.bill.status).toBe("PARTIAL");
  });
});
