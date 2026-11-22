import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    env: { NODE_ENV: "test" },
    silent: false,
    // the PostgreSQL suites share one database and drop/recreate its tables, so files must not run in parallel then
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
