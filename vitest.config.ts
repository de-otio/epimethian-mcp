import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/shared/types.ts"],
      thresholds: {
        "src/server/**": {
          lines: 80,
          branches: 80,
          functions: 80,
          statements: 80,
        },
        "src/extension/**": {
          lines: 80,
          branches: 60,
          functions: 80,
          statements: 80,
        },
      },
    },
  },
});
