import type { UsageType } from "./calculator.js";

export interface SubscriberUsage {
  subscriberNo: string;
  month: number;
  year: number;
  usageType: UsageType;
  amount: number;
}

export interface PaymentRecord {
  subscriberNo: string;
  month: number;
  year: number;
  amount: number;
  transactionId: string;
}

export interface BillRecord {
  subscriberNo: string;
  month: number;
  year: number;
  phoneMinutes: number;
  internetMb: number;
  phoneCharge: number;
  internetCharge: number;
  total: number;
  paidAmount: number;
  remainingBalance: number;
  status: "PAID" | "PARTIAL" | "UNPAID";
}
