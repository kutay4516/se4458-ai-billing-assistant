import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { deriveBill } from "./bill.js";
import { calculateCharges, fromCents, toCents } from "./pricing.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import type { BillingStore, PayInput } from "./store.js";
import { DomainError, USAGE_INCREMENT } from "./types.js";
import type { Bill, BillSnapshot, DetailedBill, PaymentRecord, UsageEntry, UsageIncrement, UsageType } from "./types.js";

const FK_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

type Queryable = Pick<pg.Pool, "query">;

const BILL_SELECT = `
  SELECT b.subscriber_no, b.month, b.year, b.phone_minutes, b.internet_mb, b.phone_charge,
         b.internet_base_charge, b.internet_overage_charge, b.total, b.calculated_at,
         COALESCE((SELECT SUM(p.amount) FROM payments p
                    WHERE p.subscriber_no = b.subscriber_no AND p.month = b.month AND p.year = b.year), 0) AS paid
    FROM bills b`;

function toBill(row: any): Bill {
  const snapshot: BillSnapshot = {
    subscriberNo: row.subscriber_no, month: Number(row.month), year: Number(row.year),
    phoneMinutes: Number(row.phone_minutes), internetMb: Number(row.internet_mb),
    phoneCharge: Number(row.phone_charge), internetBaseCharge: Number(row.internet_base_charge),
    internetOverageCharge: Number(row.internet_overage_charge), total: Number(row.total),
    calculatedAt: new Date(row.calculated_at).toISOString(),
  };
  return deriveBill(snapshot, Number(row.paid));
}

export class PostgresBillingStore implements BillingStore {
  constructor(private readonly pool: pg.Pool, private readonly migrationsDir = path.resolve(process.cwd(), "migrations")) {}

  async init() {
    const files = (await readdir(this.migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) await this.pool.query(await readFile(path.join(this.migrationsDir, file), "utf8"));
  }

  async close() { await this.pool.end(); }

  async upsertSubscriber(input: { subscriberNo: string; displayName: string; password: string }) {
    await this.pool.query(
      `INSERT INTO subscribers(subscriber_no, display_name, password_hash) VALUES ($1,$2,$3)
       ON CONFLICT (subscriber_no) DO UPDATE SET display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash`,
      [input.subscriberNo, input.displayName, await hashPassword(input.password)],
    );
  }

  async verifyCredentials(subscriberNo: string, password: string) {
    const result = await this.pool.query("SELECT password_hash FROM subscribers WHERE subscriber_no = $1", [subscriberNo]);
    return verifyPassword(password, result.rows[0]?.password_hash);
  }

  async addUsage(input: { subscriberNo: string; month: number; year: number; usageType: UsageType; amount?: number }): Promise<UsageIncrement> {
    const increment = USAGE_INCREMENT[input.usageType];
    const amount = input.amount ?? increment.amount;
    try {
      await this.pool.query(
        "INSERT INTO usage_records(subscriber_no, month, year, usage_type, amount) VALUES ($1,$2,$3,$4,$5)",
        [input.subscriberNo, input.month, input.year, input.usageType, amount],
      );
    } catch (error: any) {
      if (error?.code === FK_VIOLATION) throw new DomainError("SUBSCRIBER_NOT_FOUND", 404, `Subscriber ${input.subscriberNo} does not exist`);
      throw error;
    }
    return { subscriberNo: input.subscriberNo, month: input.month, year: input.year, usageType: input.usageType, added: amount, unit: increment.unit };
  }

  async hasUsage(subscriberNo: string, month: number, year: number, usageType?: UsageType) {
    const result = await this.pool.query(
      "SELECT 1 FROM usage_records WHERE subscriber_no=$1 AND month=$2 AND year=$3 AND ($4::text IS NULL OR usage_type=$4) LIMIT 1",
      [subscriberNo, month, year, usageType ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async calculateBill(subscriberNo: string, month: number, year: number): Promise<Bill> {
    const subscriber = await this.pool.query("SELECT 1 FROM subscribers WHERE subscriber_no=$1", [subscriberNo]);
    if (!subscriber.rowCount) throw new DomainError("SUBSCRIBER_NOT_FOUND", 404, `Subscriber ${subscriberNo} does not exist`);

    const sums = await this.pool.query(
      "SELECT usage_type, SUM(amount) AS total FROM usage_records WHERE subscriber_no=$1 AND month=$2 AND year=$3 GROUP BY usage_type",
      [subscriberNo, month, year],
    );
    const totalFor = (type: UsageType) => Number(sums.rows.find((r: any) => r.usage_type === type)?.total ?? 0);
    const charges = calculateCharges(totalFor("Phone"), totalFor("Internet"));

    await this.pool.query(
      `INSERT INTO bills(subscriber_no, month, year, phone_minutes, internet_mb, phone_charge, internet_base_charge, internet_overage_charge, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (subscriber_no, month, year) DO UPDATE SET
         phone_minutes = EXCLUDED.phone_minutes, internet_mb = EXCLUDED.internet_mb, phone_charge = EXCLUDED.phone_charge,
         internet_base_charge = EXCLUDED.internet_base_charge, internet_overage_charge = EXCLUDED.internet_overage_charge,
         total = EXCLUDED.total, calculated_at = NOW()`,
      [subscriberNo, month, year, charges.phoneMinutes, charges.internetMb, charges.phoneCharge, charges.internetBaseCharge, charges.internetOverageCharge, charges.total],
    );
    return (await this.getBill(subscriberNo, month, year))!;
  }

  async getBill(subscriberNo: string, month: number, year: number, db: Queryable = this.pool): Promise<Bill | null> {
    const result = await db.query(`${BILL_SELECT} WHERE b.subscriber_no=$1 AND b.month=$2 AND b.year=$3`, [subscriberNo, month, year]);
    return result.rows[0] ? toBill(result.rows[0]) : null;
  }

  async getBillDetailed(subscriberNo: string, month: number, year: number, paging: { page: number; pageSize: number }): Promise<DetailedBill | null> {
    const bill = await this.getBill(subscriberNo, month, year);
    if (!bill) return null;
    const count = await this.pool.query("SELECT COUNT(*) AS n FROM usage_records WHERE subscriber_no=$1 AND month=$2 AND year=$3", [subscriberNo, month, year]);
    const rows = await this.pool.query(
      `SELECT id, usage_type, amount, recorded_at FROM usage_records WHERE subscriber_no=$1 AND month=$2 AND year=$3
        ORDER BY id DESC LIMIT $4 OFFSET $5`,
      [subscriberNo, month, year, paging.pageSize, (paging.page - 1) * paging.pageSize],
    );
    const items: UsageEntry[] = rows.rows.map((r: any) => ({
      id: Number(r.id), usageType: r.usage_type, amount: Number(r.amount),
      unit: USAGE_INCREMENT[r.usage_type as UsageType].unit, recordedAt: new Date(r.recorded_at).toISOString(),
    }));
    const totalItems = Number(count.rows[0].n);
    const payments = await this.pool.query(
      "SELECT transaction_id, subscriber_no, month, year, amount, created_at FROM payments WHERE subscriber_no=$1 AND month=$2 AND year=$3 ORDER BY created_at",
      [subscriberNo, month, year],
    );
    return {
      bill,
      usage: { items, page: paging.page, pageSize: paging.pageSize, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / paging.pageSize)) },
      payments: payments.rows.map((r: any): PaymentRecord => ({
        transactionId: r.transaction_id, subscriberNo: r.subscriber_no, month: Number(r.month), year: Number(r.year),
        amount: Number(r.amount), createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  }

  async payBill(input: PayInput): Promise<{ payment: PaymentRecord; bill: Bill }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the bill row so concurrent payments for one bill are serialised.
      const locked = await client.query("SELECT 1 FROM bills WHERE subscriber_no=$1 AND month=$2 AND year=$3 FOR UPDATE", [input.subscriberNo, input.month, input.year]);
      if (!locked.rowCount) throw new DomainError("BILL_NOT_FOUND", 404, "No calculated bill exists for this period");

      const inserted = await client.query(
        `INSERT INTO payments(transaction_id, subscriber_no, month, year, amount) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (transaction_id) DO NOTHING RETURNING created_at`,
        [input.transactionId, input.subscriberNo, input.month, input.year, input.amount],
      );
      if (!inserted.rowCount) throw new DomainError("DUPLICATE_TRANSACTION", 409, `Transaction ${input.transactionId} was already processed`);

      const bill = (await this.getBill(input.subscriberNo, input.month, input.year, client))!;
      const overpaid = toCents(bill.paidAmount) > toCents(bill.total);
      if (overpaid) {
        const before = fromCents(toCents(bill.paidAmount) - toCents(input.amount));
        const remainingBefore = fromCents(Math.max(0, toCents(bill.total) - toCents(before)));
        throw new DomainError(remainingBefore === 0 ? "NO_BALANCE_DUE" : "PAYMENT_EXCEEDS_BALANCE", 422,
          remainingBefore === 0 ? "This bill has no remaining balance" : `Amount exceeds the remaining balance of ${remainingBefore}`);
      }
      await client.query("COMMIT");
      return { payment: { ...input, createdAt: new Date(inserted.rows[0].created_at).toISOString() }, bill };
    } catch (error: any) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error?.code === UNIQUE_VIOLATION) throw new DomainError("DUPLICATE_TRANSACTION", 409, `Transaction ${input.transactionId} was already processed`);
      throw error;
    } finally {
      client.release();
    }
  }
}
