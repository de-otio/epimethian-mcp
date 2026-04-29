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
        // Security-critical converter helpers — tightened to 95%.
        "src/server/converter/escape.ts": { lines: 95, branches: 95, functions: 95, statements: 95 },
        "src/server/converter/url-parser.ts": { lines: 95, branches: 95, functions: 95, statements: 95 },
        "src/server/converter/account-id-validator.ts": { lines: 95, branches: 95, functions: 95, statements: 95 },
        "src/server/converter/filename-validator.ts": { lines: 95, branches: 95, functions: 95, statements: 95 },
        "src/server/converter/allowlist.ts": { lines: 95, branches: 95, functions: 95, statements: 95 },
        "src/server/converter/tokeniser.ts": { lines: 95, branches: 95, functions: 95, statements: 95 },
        "src/server/converter/restore.ts": { lines: 95, branches: 95, functions: 95, statements: 95 },
        "src/server/converter/diff.ts": { lines: 95, branches: 95, functions: 95, statements: 95 },
        // Trust-boundary module for soft-elicitation (v6.6.0). Tightened to
        // 90% — coverage gaps here mean untested states where a wrong-page
        // or replayed token could validate. See plan §7 + §3.2 note 1.
        "src/server/confirmation-tokens.ts": { lines: 90, branches: 90, functions: 90, statements: 90 },
        // Per-client config templates for the setup CLI (v6.5.0). Mechanical
        // templating; 85% threshold per plan §7.
        "src/cli/client-configs.ts": { lines: 85, branches: 85, functions: 85, statements: 85 },
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
