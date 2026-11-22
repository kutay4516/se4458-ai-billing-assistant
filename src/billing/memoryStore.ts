import { deriveBill, pageOf } from "./bill.js";
import { calculateCharges, toCents } from "./pricing.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import type { BillingStore, PayInput } from "./store.js";
import { DomainError, USAGE_INCREMENT } from "./types.js";
import type { Bill, BillSnapshot, DetailedBill, PaymentRecord, UsageEntry, UsageIncrement, UsageType } from "./types.js";

interface UsageRow { id: number; subscriberNo: string; month: number; year: number; usageType: UsageType; amount: number; recordedAt: string }

export class MemoryBillingStore implements BillingStore {
  private subscribers = new Map<string, { displayName: string; passwordHash: string }>();
  private usage: UsageRow[] = [];
  private bills = new Map<string, BillSnapshot>();
  private payments: PaymentRecord[] = [];
  private nextUsageId = 1;

  private key = (s: string, m: number, y: number) => `${s}|${y}-${m}`;
  async init() {}
  async close() {}

  async upsertSubscriber(input: { subscriberNo: string; displayName: string; password: string }) {
    this.subscribers.set(input.subscriberNo, { displayName: input.displayName, passwordHash: await hashPassword(input.password) });
  }

  async verifyCredentials(subscriberNo: string, password: string) {
    return verifyPassword(password, this.subscribers.get(subscriberNo)?.passwordHash);
  }

  private requireSubscriber(subscriberNo: string) {
    if (!this.subscribers.has(subscriberNo)) throw new DomainError("SUBSCRIBER_NOT_FOUND", 404, `Subscriber ${subscriberNo} does not exist`);
  }

  async addUsage(input: { subscriberNo: string; month: number; year: number; usageType: UsageType; amount?: number }): Promise<UsageIncrement> {
    this.requireSubscriber(input.subscriberNo);
    const increment = USAGE_INCREMENT[input.usageType];
    const amount = input.amount ?? increment.amount;
    this.usage.push({ id: this.nextUsageId++, subscriberNo: input.subscriberNo, month: input.month, year: input.year, usageType: input.usageType, amount, recordedAt: new Date().toISOString() });
    return { subscriberNo: input.subscriberNo, month: input.month, year: input.year, usageType: input.usageType, added: amount, unit: increment.unit };
  }

  private periodUsage(subscriberNo: string, month: number, year: number) {
    return this.usage.filter((u) => u.subscriberNo === subscriberNo && u.month === month && u.year === year);
  }

  async hasUsage(subscriberNo: string, month: number, year: number, usageType?: UsageType) {
    return this.periodUsage(subscriberNo, month, year).some((u) => !usageType || u.usageType === usageType);
  }

  private paid(subscriberNo: string, month: number, year: number) {
    return this.payments.filter((p) => p.subscriberNo === subscriberNo && p.month === month && p.year === year).reduce((sum, p) => sum + toCents(p.amount), 0) / 100;
  }

  async calculateBill(subscriberNo: string, month: number, year: number): Promise<Bill> {
    this.requireSubscriber(subscriberNo);
    const rows = this.periodUsage(subscriberNo, month, year);
    const sum = (type: UsageType) => rows.filter((r) => r.usageType === type).reduce((s, r) => s + r.amount, 0);
    const charges = calculateCharges(sum("Phone"), sum("Internet"));
    const snapshot: BillSnapshot = {
      subscriberNo, month, year, phoneMinutes: charges.phoneMinutes, internetMb: charges.internetMb,
      phoneCharge: charges.phoneCharge, internetBaseCharge: charges.internetBaseCharge,
      internetOverageCharge: charges.internetOverageCharge, total: charges.total, calculatedAt: new Date().toISOString(),
    };
    this.bills.set(this.key(subscriberNo, month, year), snapshot);
    return deriveBill(snapshot, this.paid(subscriberNo, month, year));
  }

  private billSync(subscriberNo: string, month: number, year: number): Bill | null {
    const snapshot = this.bills.get(this.key(subscriberNo, month, year));
    return snapshot ? deriveBill(snapshot, this.paid(subscriberNo, month, year)) : null;
  }

  async getBill(subscriberNo: string, month: number, year: number): Promise<Bill | null> {
    return this.billSync(subscriberNo, month, year);
  }

  async getBillDetailed(subscriberNo: string, month: number, year: number, paging: { page: number; pageSize: number }): Promise<DetailedBill | null> {
    const bill = await this.getBill(subscriberNo, month, year);
    if (!bill) return null;
    const entries: UsageEntry[] = this.periodUsage(subscriberNo, month, year)
      .sort((a, b) => b.id - a.id)
      .map((u) => ({ id: u.id, usageType: u.usageType, amount: u.amount, unit: USAGE_INCREMENT[u.usageType].unit, recordedAt: u.recordedAt }));
    const payments = this.payments.filter((p) => p.subscriberNo === subscriberNo && p.month === month && p.year === year);
    return { bill, usage: pageOf(entries, paging.page, paging.pageSize), payments };
  }

  async payBill(input: PayInput): Promise<{ payment: PaymentRecord; bill: Bill }> {
    if (this.payments.some((p) => p.transactionId === input.transactionId)) {
      throw new DomainError("DUPLICATE_TRANSACTION", 409, `Transaction ${input.transactionId} was already processed`);
    }
    // Synchronous critical section: duplicate check and insert cannot interleave with another call.
    const bill = this.billSync(input.subscriberNo, input.month, input.year);
    if (!bill) throw new DomainError("BILL_NOT_FOUND", 404, "No calculated bill exists for this period");
    if (toCents(bill.remainingBalance) === 0) throw new DomainError("NO_BALANCE_DUE", 422, "This bill has no remaining balance");
    if (toCents(input.amount) > toCents(bill.remainingBalance)) {
      throw new DomainError("PAYMENT_EXCEEDS_BALANCE", 422, `Amount exceeds the remaining balance of ${bill.remainingBalance}`);
    }
    const payment: PaymentRecord = { ...input, createdAt: new Date().toISOString() };
    this.payments.push(payment);
    return { payment, bill: this.billSync(input.subscriberNo, input.month, input.year)! };
  }
}
