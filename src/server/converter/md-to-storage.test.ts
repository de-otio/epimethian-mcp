import { describe, expect, it } from "vitest";
import { markdownToStorage } from "./md-to-storage.js";

describe("md-to-storage (Stream 0 stub)", () => {
  it("markdownToStorage is wired but not implemented", () => {
    expect(() => markdownToStorage("# hello")).toThrow("not implemented");
  });
});
