import { describe, expect, it } from "vitest";
import { MACRO_ALLOWLIST, isMacroAllowed } from "./allowlist.js";

const EXPECTED = [
  "info",
  "note",
  "warning",
  "tip",
  "success",
  "panel",
  "code",
  "expand",
  "toc",
  "status",
  "anchor",
  "excerpt",
  "excerpt-include",
  "drawio",
  "children",
  "jira",
];

describe("MACRO_ALLOWLIST", () => {
  it("contains exactly the macros specified in 04-markdown-syntax-design.md § Channel 4", () => {
    expect([...MACRO_ALLOWLIST].sort()).toEqual([...EXPECTED].sort());
  });

  it("has no duplicates", () => {
    expect(new Set(MACRO_ALLOWLIST).size).toBe(MACRO_ALLOWLIST.length);
  });

  it("is frozen (cannot be mutated at runtime)", () => {
    expect(Object.isFrozen(MACRO_ALLOWLIST)).toBe(true);
  });
});

describe("isMacroAllowed — accepts every allowlisted name", () => {
  it.each(EXPECTED.map((name) => [name]))("accepts %s", (name) => {
    expect(isMacroAllowed(name)).toBe(true);
  });
});

describe("isMacroAllowed — case sensitivity", () => {
  it("rejects capitalised variants", () => {
    expect(isMacroAllowed("Info")).toBe(false);
    expect(isMacroAllowed("INFO")).toBe(false);
    expect(isMacroAllowed("iNfO")).toBe(false);
  });

  it("rejects mixed case on compound names", () => {
    expect(isMacroAllowed("Excerpt-Include")).toBe(false);
    expect(isMacroAllowed("EXCERPT-INCLUDE")).toBe(false);
  });
});

describe("isMacroAllowed — whitespace and punctuation bypass attempts", () => {
  it("rejects trailing whitespace", () => {
    expect(isMacroAllowed("info ")).toBe(false);
    expect(isMacroAllowed("info\t")).toBe(false);
    expect(isMacroAllowed("info\n")).toBe(false);
  });

  it("rejects leading whitespace", () => {
    expect(isMacroAllowed(" info")).toBe(false);
  });

  it("rejects trailing punctuation / markup", () => {
    expect(isMacroAllowed("info<")).toBe(false);
    expect(isMacroAllowed("info>")).toBe(false);
    expect(isMacroAllowed("info/")).toBe(false);
    expect(isMacroAllowed("info\"")).toBe(false);
    expect(isMacroAllowed("info'")).toBe(false);
  });

  it("rejects null-terminator smuggling", () => {
    expect(isMacroAllowed("info\u0000")).toBe(false);
    expect(isMacroAllowed("info\u0000evil")).toBe(false);
  });
});

describe("isMacroAllowed — rejections for non-allowlisted names", () => {
  it("rejects known-dangerous macros explicitly", () => {
    expect(isMacroAllowed("html")).toBe(false);
    expect(isMacroAllowed("iframe")).toBe(false);
    expect(isMacroAllowed("webhook")).toBe(false);
    expect(isMacroAllowed("redirect")).toBe(false);
    expect(isMacroAllowed("external-content-import")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isMacroAllowed("")).toBe(false);
  });

  it("rejects arbitrary unknown strings", () => {
    expect(isMacroAllowed("my-made-up-macro")).toBe(false);
    expect(isMacroAllowed("../info")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    // @ts-expect-error -- intentional
    expect(isMacroAllowed(null)).toBe(false);
    // @ts-expect-error -- intentional
    expect(isMacroAllowed(undefined)).toBe(false);
    // @ts-expect-error -- intentional
    expect(isMacroAllowed(42)).toBe(false);
    // @ts-expect-error -- intentional
    expect(isMacroAllowed(["info"])).toBe(false);
  });
});
