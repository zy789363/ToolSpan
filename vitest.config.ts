import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: process.env.CI === "true" ? 15_000 : 5_000,
  },
});
