import type { Bill, DetailedBill, PaymentRecord, UsageIncrement, UsageType } from "./types.js";

export interface PayInput {
  subscriberNo: string;
  month: number;
  year: number;
  amount: number;
  transactionId: string;
}

/** Persistence contract implemented by the in-memory (unit tests) and PostgreSQL (deployment) stores. */
export interface BillingStore {
  init(): Promise<void>;
  close(): Promise<void>;
  upsertSubscriber(input: { subscriberNo: string; displayName: string; password: string }): Promise<void>;
  verifyCredentials(subscriberNo: string, password: string): Promise<boolean>;
  /** Add Usage: one call adds 10 minutes (Phone) or 1 MB (Internet). `amount` is for seeding only. */
  addUsage(input: { subscriberNo: string; month: number; year: number; usageType: UsageType; amount?: number }): Promise<UsageIncrement>;
  hasUsage(subscriberNo: string, month: number, year: number, usageType?: UsageType): Promise<boolean>;
  /** Calculate Bill: snapshot the period's usage into a persisted bill (idempotent, recalculation overwrites). */
  calculateBill(subscriberNo: string, month: number, year: number): Promise<Bill>;
  getBill(subscriberNo: string, month: number, year: number): Promise<Bill | null>;
  getBillDetailed(subscriberNo: string, month: number, year: number, paging: { page: number; pageSize: number }): Promise<DetailedBill | null>;
  payBill(input: PayInput): Promise<{ payment: PaymentRecord; bill: Bill }>;
}
