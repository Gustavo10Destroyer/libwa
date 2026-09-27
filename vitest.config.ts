import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/backend/baileys/**", "src/index.ts"],
    },
  },
});
