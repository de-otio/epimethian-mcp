import { describe, expect, it } from "vitest";
import { parseConfluenceUrl } from "./url-parser.js";

describe("url-parser (Stream 0 stub)", () => {
  it("parseConfluenceUrl is wired but not implemented", () => {
    expect(() => parseConfluenceUrl("x", "y")).toThrow("not implemented");
  });
});
