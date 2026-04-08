import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        "src/server/**": {
          lines: 80,
          branches: 80,
          functions: 80,
          statements: 80,
        },
        "src/cli/**": {
          lines: 60,
          branches: 60,
          functions: 60,
          statements: 60,
        },
      },
    },
  },
});
