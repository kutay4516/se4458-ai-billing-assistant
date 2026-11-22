import pg from "pg";
import { MemoryBillingStore } from "../billing/memoryStore.js";
import { PostgresBillingStore } from "../billing/postgresStore.js";
import { seedDemoData } from "../billing/seed.js";
import { buildApi } from "./app.js";

const store = process.env.DATABASE_URL
  ? new PostgresBillingStore(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 }))
  : new MemoryBillingStore();
await store.init();

if (process.env.SEED_DEMO_DATA !== "false") {
  const password = process.env.DEMO_PASSWORD;
  if (!password && process.env.NODE_ENV === "production") throw new Error("DEMO_PASSWORD is required to seed demo subscribers (or set SEED_DEMO_DATA=false)");
  await seedDemoData(store, password ?? "demo-password");
}

const app = buildApi({ store, logger: true });
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
console.log(`Billing API using ${process.env.DATABASE_URL ? "PostgreSQL" : "in-memory store (no DATABASE_URL)"}`);
