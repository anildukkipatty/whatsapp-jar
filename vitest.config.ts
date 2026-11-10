import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: "test/global-setup.ts",
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      DATABASE_URL: "postgres://jar:jar@127.0.0.1:5433/whatsapp_jar_test",
      DEBOUNCE_MS: "150",
      DEBOUNCE_MAX_MS: "1000",
      RETRY_BASE_MS: "50",
      LEASE_MS: "60000",
      // Off unless a test turns them on, so no test reaches a real MCP server.
      MCP_CONFIG: "",
      SKILLS_DIR: "",
    },
  },
});
