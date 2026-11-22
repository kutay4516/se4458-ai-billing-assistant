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
      "SELECT subscriber_no AS \"subscriberNo\", month, year, usage_type AS \"usageType\", amount FROM usage_records WHERE subscriber_no=$1 AND month=$2 AND year=$3 ORDER BY id",
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
      "SELECT subscriber_no AS \"subscriberNo\", month, year, amount, transaction_id AS \"transactionId\" FROM payments WHERE subscriber_no=$1 AND month=$2 AND year=$3 ORDER BY created_at, transaction_id",
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
    if (input.amount <= 0) throw new Error("INVALID_PAYMENT_AMOUNT");
    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      const billingPeriod = `${input.subscriberNo}:${input.year}-${input.month}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [billingPeriod]);

      const duplicate = await client.query("SELECT 1 FROM payments WHERE transaction_id=$1", [input.transactionId]);
      if (duplicate.rowCount) throw new Error("DUPLICATE_TRANSACTION");

      const usage = await client.query(
        "SELECT usage_type AS \"usageType\", amount FROM usage_records WHERE subscriber_no=$1 AND month=$2 AND year=$3",
        [input.subscriberNo, input.month, input.year],
      );
      const records = usage.rows.map((row: any) => ({ usageType: row.usageType as "Phone" | "Internet", amount: Number(row.amount) }));
      const calculation = calculateBill(records);
      const payments = await client.query(
        "SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE subscriber_no=$1 AND month=$2 AND year=$3",
        [input.subscriberNo, input.month, input.year],
      );
      const paidAmount = Number(payments.rows[0].paid);
      const remainingBalance = Math.max(0, calculation.total - paidAmount);
      if (input.amount > remainingBalance) throw new Error("PAYMENT_EXCEEDS_BALANCE");

      await client.query(
        "INSERT INTO payments(transaction_id, subscriber_no, month, year, amount) VALUES ($1,$2,$3,$4,$5)",
        [input.transactionId, input.subscriberNo, input.month, input.year, input.amount],
      );
      const updatedPaidAmount = paidAmount + input.amount;
      const updatedRemainingBalance = Math.max(0, calculation.total - updatedPaidAmount);
      const bill = {
        subscriberNo: input.subscriberNo,
        month: input.month,
        year: input.year,
        phoneMinutes: records.filter((row) => row.usageType === "Phone").reduce((sum, row) => sum + row.amount, 0),
        internetMb: records.filter((row) => row.usageType === "Internet").reduce((sum, row) => sum + row.amount, 0),
        phoneCharge: calculation.phoneCharge,
        internetCharge: calculation.internetCharge,
        total: calculation.total,
        paidAmount: updatedPaidAmount,
        remainingBalance: updatedRemainingBalance,
        status: this.statusFor(calculation.total, updatedPaidAmount, updatedRemainingBalance),
      };
      await client.query("COMMIT");
      inTransaction = false;
      return { payment: input, bill };
    } catch (error) {
      if (inTransaction) await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw new Error("DUPLICATE_TRANSACTION");
      throw error;
    } finally {
      client.release();
    }
  }
}
