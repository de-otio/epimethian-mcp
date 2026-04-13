import { describe, expect, it } from "vitest";
import { MACRO_ALLOWLIST, isMacroAllowed } from "./allowlist.js";

describe("allowlist (Stream 0 stub)", () => {
  it("MACRO_ALLOWLIST is exported (initially empty until Stream 1)", () => {
    expect(Array.isArray(MACRO_ALLOWLIST)).toBe(true);
  });
  it("isMacroAllowed is wired but not implemented", () => {
    expect(() => isMacroAllowed("x")).toThrow("not implemented");
  });
});
