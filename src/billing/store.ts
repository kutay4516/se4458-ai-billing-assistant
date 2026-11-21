import { calculateBill } from "./calculator.js";
import type { BillRecord, PaymentRecord, SubscriberUsage } from "./types.js";

export class BillingStore {
  private usage = new Map<string, SubscriberUsage[]>();
  private payments = new Map<string, PaymentRecord[]>();

  private key(subscriberNo: string, month: number, year: number): string {
    return `${subscriberNo}:${year}-${month}`;
  }

  addUsage(record: SubscriberUsage): SubscriberUsage {
    const key = this.key(record.subscriberNo, record.month, record.year);
    const records = this.usage.get(key) ?? [];
    records.push(record);
    this.usage.set(key, records);
    return record;
  }

  getUsage(subscriberNo: string, month: number, year: number): SubscriberUsage[] {
    return this.usage.get(this.key(subscriberNo, month, year)) ?? [];
  }

  calculateBill(subscriberNo: string, month: number, year: number): BillRecord {
    const usage = this.getUsage(subscriberNo, month, year);
    const phoneMinutes = usage
      .filter((record) => record.usageType === "Phone")
      .reduce((sum, record) => sum + record.amount, 0);
    const internetMb = usage
      .filter((record) => record.usageType === "Internet")
      .reduce((sum, record) => sum + record.amount, 0);
    const calculation = calculateBill(usage);
    const paidAmount = this.getPayments(subscriberNo, month, year)
      .reduce((sum, payment) => sum + payment.amount, 0);
    const remainingBalance = Math.max(0, calculation.total - paidAmount);

    return {
      subscriberNo,
      month,
      year,
      phoneMinutes,
      internetMb,
      phoneCharge: calculation.phoneCharge,
      internetCharge: calculation.internetCharge,
      total: calculation.total,
      paidAmount,
      remainingBalance,
      status: remainingBalance === 0 && calculation.total > 0
        ? "PAID"
        : paidAmount > 0
          ? "PARTIAL"
          : "UNPAID",
    };
  }

  getPayments(subscriberNo: string, month: number, year: number): PaymentRecord[] {
    return this.payments.get(this.key(subscriberNo, month, year)) ?? [];
  }

  payBill(record: PaymentRecord): { payment: PaymentRecord; bill: BillRecord } {
    const key = this.key(record.subscriberNo, record.month, record.year);
    const payments = this.payments.get(key) ?? [];

    if (payments.some((payment) => payment.transactionId === record.transactionId)) {
      throw new Error("DUPLICATE_TRANSACTION");
    }

    const bill = this.calculateBill(record.subscriberNo, record.month, record.year);
    if (record.amount <= 0) throw new Error("INVALID_PAYMENT_AMOUNT");
    if (record.amount > bill.remainingBalance) throw new Error("PAYMENT_EXCEEDS_BALANCE");

    payments.push(record);
    this.payments.set(key, payments);
    return { payment: record, bill: this.calculateBill(record.subscriberNo, record.month, record.year) };
  }
}
