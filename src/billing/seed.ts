import type { BillingStore } from "./store.js";
import type { UsageType } from "./types.js";

export interface DemoPeriod { subscriberNo: string; month: number; year: number; phone: number; internetMb: number }

/** Deterministic demo data documented in the README (Oct 2026 is higher than Sep 2026 for the "why higher?" scenario). */
export const DEMO_SUBSCRIBERS = [
  { subscriberNo: "1001", displayName: "Demo Subscriber 1001" },
  { subscriberNo: "1002", displayName: "Demo Subscriber 1002" },
];

export const DEMO_PERIODS: DemoPeriod[] = [
  { subscriberNo: "1001", month: 4, year: 2025, phone: 1200, internetMb: 35_000 },
  { subscriberNo: "1001", month: 9, year: 2026, phone: 900, internetMb: 18_000 },
  { subscriberNo: "1001", month: 10, year: 2026, phone: 2300, internetMb: 47_000 },
  { subscriberNo: "1002", month: 10, year: 2026, phone: 500, internetMb: 5_000 },
];

/**
 * Idempotent and safe to interrupt: every (period, usage type) is checked on its own, so a start that was killed half way
 * through seeding is completed by the next start. A usage type that already has records is left untouched, and the bill
 * snapshot is recalculated (payments are kept) only when something was added.
 */
export async function seedDemoData(store: BillingStore, password: string): Promise<void> {
  for (const subscriber of DEMO_SUBSCRIBERS) await store.upsertSubscriber({ ...subscriber, password });
  for (const period of DEMO_PERIODS) {
    let added = false;
    const entries: Array<[UsageType, number]> = [["Phone", period.phone], ["Internet", period.internetMb]];
    for (const [usageType, amount] of entries) {
      if (await store.hasUsage(period.subscriberNo, period.month, period.year, usageType)) continue;
      await store.addUsage({ subscriberNo: period.subscriberNo, month: period.month, year: period.year, usageType, amount });
      added = true;
    }
    if (added || !(await store.getBill(period.subscriberNo, period.month, period.year))) {
      await store.calculateBill(period.subscriberNo, period.month, period.year);
    }
  }
}
