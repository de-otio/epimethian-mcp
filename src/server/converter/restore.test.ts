import { describe, expect, it } from "vitest";
import { restoreFromTokens } from "./restore.js";

describe("restore (Stream 0 stub)", () => {
  it("restoreFromTokens is wired but not implemented", () => {
    expect(() => restoreFromTokens("x", {})).toThrow("not implemented");
  });
});
