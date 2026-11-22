import type { FastifyInstance } from "fastify";
import { buildApi } from "../src/api/app.js";
import { MemoryBillingStore } from "../src/billing/memoryStore.js";
import { seedDemoData } from "../src/billing/seed.js";

export const DEMO_PASSWORD = "unit-test-password";

export async function makeApi() {
  const store = new MemoryBillingStore();
  await store.init();
  await seedDemoData(store, DEMO_PASSWORD);
  const app = buildApi({ store });
  await app.ready();
  return { app, store };
}

export async function login(app: FastifyInstance, subscriberNo = "1001", password = DEMO_PASSWORD): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/token", payload: { subscriberNo, password } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  return res.json().token;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}
