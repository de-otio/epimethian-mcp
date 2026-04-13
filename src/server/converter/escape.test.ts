import { describe, expect, it } from "vitest";
import { escapeCdata, escapeXmlAttr, escapeXmlText } from "./escape.js";

describe("escape (Stream 0 stubs)", () => {
  it("escapeXmlAttr is wired but not implemented", () => {
    expect(() => escapeXmlAttr("x")).toThrow("not implemented");
  });
  it("escapeXmlText is wired but not implemented", () => {
    expect(() => escapeXmlText("x")).toThrow("not implemented");
  });
  it("escapeCdata is wired but not implemented", () => {
    expect(() => escapeCdata("x")).toThrow("not implemented");
  });
});
