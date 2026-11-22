import { fromCents, toCents } from "./pricing.js";
import type { Bill, BillSnapshot, BillStatus, Page } from "./types.js";

export function deriveBill(snapshot: BillSnapshot, paidAmount: number): Bill {
  const totalCents = toCents(snapshot.total);
  const paidCents = toCents(paidAmount);
  const remainingCents = Math.max(0, totalCents - paidCents);
  const status: BillStatus = remainingCents === 0 && totalCents > 0 ? "PAID" : paidCents > 0 ? "PARTIAL" : "UNPAID";
  return {
    ...snapshot,
    internetGb: snapshot.internetMb / 1000,
    internetCharge: snapshot.internetBaseCharge + snapshot.internetOverageCharge,
    paidAmount: fromCents(paidCents),
    remainingBalance: fromCents(remainingCents),
    status,
  };
}

export function pageOf<T>(all: T[], page: number, pageSize: number): Page<T> {
  const totalItems = all.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const start = (page - 1) * pageSize;
  return { items: all.slice(start, start + pageSize), page, pageSize, totalItems, totalPages };
}
