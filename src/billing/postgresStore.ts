import pg from "pg";
import { calculateBill } from "./calculator.js";

export class PostgresBillingStore {
  constructor(private readonly pool: pg.Pool) {}

  async addUsage(input: { subscriberNo: string; month: number; year: number; usageType: "Phone" | "Internet"; amount: number }) {
    await this.pool.query(
      "INSERT INTO usage_records(subscriber_no, month, year, usage_type, amount) VALUES ($1,$2,$3,$4,$5)",
      [input.subscriberNo, input.month, input.year, input.usageType, input.amount],
    );
    return input;
  }

  async calculateBill(subscriberNo: string, month: number, year: number) {
    const usage = await this.pool.query(
      "SELECT usage_type AS \"usageType\", amount FROM usage_records WHERE subscriber_no=$1 AND month=$2 AND year=$3",
      [subscriberNo, month, year],
    );
    const records = usage.rows.map((row: any) => ({ usageType: row.usageType as "Phone" | "Internet", amount: Number(row.amount) }));
    const phoneMinutes = records.filter((row) => row.usageType === "Phone").reduce((sum, row) => sum + row.amount, 0);
    const internetMb = records.filter((row) => row.usageType === "Internet").reduce((sum, row) => sum + row.amount, 0);
    const calculation = calculateBill(records);

    const payments = await this.pool.query(
      "SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE subscriber_no=$1 AND month=$2 AND year=$3",
      [subscriberNo, month, year],
    );
    const paidAmount = Number(payments.rows[0].paid);
    const remainingBalance = Math.max(0, calculation.total - paidAmount);

    return {
      subscriberNo, month, year, phoneMinutes, internetMb,
      phoneCharge: calculation.phoneCharge,
      internetCharge: calculation.internetCharge,
      total: calculation.total,
      paidAmount,
      remainingBalance,
      status: this.statusFor(calculation.total, paidAmount, remainingBalance),
    };
  }

  private statusFor(total: number, paidAmount: number, remainingBalance: number): "PAID" | "PARTIAL" | "UNPAID" {
    if (remainingBalance === 0 && total > 0) return "PAID";
    if (paidAmount > 0) return "PARTIAL";
    return "UNPAID";
  }

  async getUsage(subscriberNo: string, month: number, year: number) {
    const result = await this.pool.query(
      "SELECT subscriber_no AS \"subscriberNo\", month, year, usage_type AS \"usageType\", amount FROM usage_records WHERE subscriber_no=$1 AND month=$2 AND year=$3",
      [subscriberNo, month, year],
    );
    return result.rows.map((row: any) => ({
      subscriberNo: row.subscriberNo,
      month: Number(row.month),
      year: Number(row.year),
      usageType: row.usageType as "Phone" | "Internet",
      amount: Number(row.amount),
    }));
  }

  async getPayments(subscriberNo: string, month: number, year: number) {
    const result = await this.pool.query(
      "SELECT subscriber_no AS \"subscriberNo\", month, year, amount, transaction_id AS \"transactionId\" FROM payments WHERE subscriber_no=$1 AND month=$2 AND year=$3",
      [subscriberNo, month, year],
    );
    return result.rows.map((row: any) => ({
      subscriberNo: row.subscriberNo,
      month: Number(row.month),
      year: Number(row.year),
      amount: Number(row.amount),
      transactionId: row.transactionId,
    }));
  }

  async payBill(input: { subscriberNo: string; month: number; year: number; amount: number; transactionId: string }) {
    const duplicate = await this.pool.query("SELECT 1 FROM payments WHERE transaction_id=$1", [input.transactionId]);
    if (duplicate.rowCount) throw new Error("DUPLICATE_TRANSACTION");

    const bill = await this.calculateBill(input.subscriberNo, input.month, input.year);
    if (input.amount > bill.remainingBalance) throw new Error("PAYMENT_EXCEEDS_BALANCE");

    await this.pool.query(
      "INSERT INTO payments(transaction_id, subscriber_no, month, year, amount) VALUES ($1,$2,$3,$4,$5)",
      [input.transactionId, input.subscriberNo, input.month, input.year, input.amount],
    );
    return { payment: input, bill: await this.calculateBill(input.subscriberNo, input.month, input.year) };
  }
}
