export type UsageType = "Phone" | "Internet";
export type BillStatus = "UNPAID" | "PARTIAL" | "PAID";

/** Increment added by one Add Usage call (assignment: +10 minutes phone, +1 MB internet). */
export const USAGE_INCREMENT: Record<UsageType, { amount: number; unit: "minutes" | "MB" }> = {
  Phone: { amount: 10, unit: "minutes" },
  Internet: { amount: 1, unit: "MB" },
};

export interface BillSnapshot {
  subscriberNo: string;
  month: number;
  year: number;
  phoneMinutes: number;
  internetMb: number;
  phoneCharge: number;
  internetBaseCharge: number;
  internetOverageCharge: number;
  total: number;
  calculatedAt: string;
}

export interface Bill extends BillSnapshot {
  internetGb: number;
  internetCharge: number;
  paidAmount: number;
  remainingBalance: number;
  status: BillStatus;
}

export interface UsageEntry {
  id: number;
  usageType: UsageType;
  amount: number;
  unit: "minutes" | "MB";
  recordedAt: string;
}

export interface PaymentRecord {
  transactionId: string;
  subscriberNo: string;
  month: number;
  year: number;
  amount: number;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface DetailedBill {
  bill: Bill;
  usage: Page<UsageEntry>;
  payments: PaymentRecord[];
}

export interface UsageIncrement {
  subscriberNo: string;
  month: number;
  year: number;
  usageType: UsageType;
  added: number;
  unit: "minutes" | "MB";
}

export class DomainError extends Error {
  constructor(public readonly code: string, public readonly httpStatus: number, message?: string) {
    super(message ?? code);
    this.name = "DomainError";
  }
}
