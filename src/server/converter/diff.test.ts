import { describe, expect, it } from "vitest";
import { diffTokens } from "./diff.js";

describe("converter/diff (Stream 0 stub)", () => {
  it("diffTokens is wired but not implemented", () => {
    expect(() => diffTokens("x", "y", {})).toThrow("not implemented");
  });
});
