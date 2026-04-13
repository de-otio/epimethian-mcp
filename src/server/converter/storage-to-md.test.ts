import { describe, expect, it } from "vitest";
import { storageToMarkdown } from "./storage-to-md.js";

describe("storage-to-md (Stream 0 stub)", () => {
  it("storageToMarkdown is wired but not implemented", () => {
    expect(() => storageToMarkdown("<p>x</p>")).toThrow("not implemented");
  });
});
