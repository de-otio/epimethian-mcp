/**
 * Structural enforcement test: only safe-write.ts may import the raw writers.
 *
 * This test greps every non-test production TypeScript file under src/
 * (server, cli, shared — whatever exists) and asserts that none of them
 * import `_rawUpdatePage` or `_rawCreatePage`. Write paths outside safe-write
 * must go through safePrepareBody + safeSubmitPage — this includes CLI
 * migrations like fix-legacy-links and any future shared helper.
 *
 * If this test fails, a future developer added a direct import of the raw
 * HTTP wrappers somewhere in production code — which bypasses the
 * write-safety pipeline.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Recursively collect all .ts files under `dir`, sorted lexicographically for
 * deterministic test output regardless of file-system order.
 */
function walkTsFiles(dir: string): string[] {
  const entries = readdirSync(dir).sort(); // sort for determinism
  const results: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

const SRC_DIR = resolve(__dirname, "..");

/**
 * Production files: .ts anywhere under src/, excluding:
 *   - *.test.ts            (tests legitimately call the raw writers for unit testing)
 *   - safe-write.ts        (the only authorised consumer of the raw writers)
 *   - confluence-client.ts (the *definition* of the raw writers — not a consumer)
 */
const productionFiles = walkTsFiles(SRC_DIR).filter(
  (f) =>
    !f.endsWith(".test.ts") &&
    !f.endsWith("safe-write.ts") &&
    !f.endsWith("confluence-client.ts"),
);

describe("raw-writer import restriction", () => {
  it("only safe-write.ts imports _rawUpdatePage or _rawCreatePage in production code", () => {
    // This test iterates explicitly over sorted files so that a failure names
    // the offending file clearly in the Vitest output.
    for (const file of productionFiles) {
      const content = readFileSync(file, "utf8");
      const relativePath = file.replace(resolve(SRC_DIR, "../..") + "/", "");

      expect(
        content,
        `${relativePath} must not import _rawUpdatePage (use safePrepareBody + safeSubmitPage instead)`,
      ).not.toMatch(/\b_rawUpdatePage\b/);

      expect(
        content,
        `${relativePath} must not import _rawCreatePage (use safePrepareBody + safeSubmitPage instead)`,
      ).not.toMatch(/\b_rawCreatePage\b/);
    }
  });

  it("safe-write.ts DOES import _rawUpdatePage and _rawCreatePage (sanity check)", () => {
    const safeWritePath = join(SRC_DIR, "server", "safe-write.ts");
    const content = readFileSync(safeWritePath, "utf8");

    expect(content).toMatch(/\b_rawUpdatePage\b/);
    expect(content).toMatch(/\b_rawCreatePage\b/);
  });
});
