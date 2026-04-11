import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __PKG_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0-test"),
  },
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
