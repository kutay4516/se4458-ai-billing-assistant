/**
 * Resets the demo payments so the payment scenario can be shown again (`npm run demo:reset -- --yes`).
 * Only the payments of the demo subscribers 1001 and 1002 are deleted; usage, bills and subscribers are kept
 * (a bill's paid amount and status are derived from its payments). Needs DATABASE_URL: the in-memory store resets on restart.
 */
import "dotenv/config";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set (the in-memory store is reset by restarting the API). Nothing to do."); process.exit(0); }
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const count = await pool.query("SELECT subscriber_no, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS total FROM payments WHERE subscriber_no IN ('1001','1002') GROUP BY subscriber_no ORDER BY 1");
  if (!count.rowCount) { console.log("No demo payments exist. Nothing to reset."); process.exit(0); }
  for (const r of count.rows) console.log(`subscriber ${r.subscriber_no}: ${r.n} payment(s), $${r.total} paid in total`);
  if (!process.argv.includes("--yes")) { console.log("\nDry run. Delete these payments with:  npm run demo:reset -- --yes"); process.exit(0); }
  const deleted = await pool.query("DELETE FROM payments WHERE subscriber_no IN ('1001','1002')");
  console.log(`\nDeleted ${deleted.rowCount} payment(s). The demo bills are unpaid again.`);
} finally {
  await pool.end();
}
