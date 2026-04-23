import { describe, expect, it } from "vitest";
import {
  InvalidToolAllowlistError,
  KNOWN_TOOLS,
  resolveToolFilter,
} from "./tool-allowlist.js";

describe("resolveToolFilter (F2)", () => {
  it("F2: no settings → all tools enabled", () => {
    const filter = resolveToolFilter(undefined);
    for (const t of KNOWN_TOOLS) expect(filter(t)).toBe(true);
  });

  it("F2: empty settings → all tools enabled", () => {
    const filter = resolveToolFilter({});
    for (const t of KNOWN_TOOLS) expect(filter(t)).toBe(true);
  });

  it("F2: allowed_tools restricts to listed tools", () => {
    const filter = resolveToolFilter({
      allowed_tools: ["get_page", "search_pages"],
    });
    expect(filter("get_page")).toBe(true);
    expect(filter("search_pages")).toBe(true);
    expect(filter("delete_page")).toBe(false);
    expect(filter("update_page")).toBe(false);
  });

  it("F2: denied_tools blocks listed tools", () => {
    const filter = resolveToolFilter({
      denied_tools: ["delete_page", "revert_page"],
    });
    expect(filter("delete_page")).toBe(false);
    expect(filter("revert_page")).toBe(false);
    expect(filter("get_page")).toBe(true);
    expect(filter("update_page")).toBe(true);
  });

  it("F2: both allowed_tools and denied_tools is a startup error", () => {
    expect(() =>
      resolveToolFilter({
        allowed_tools: ["get_page"],
        denied_tools: ["delete_page"],
      }),
    ).toThrow(InvalidToolAllowlistError);
  });

  it("F2: unknown tool names in allowed_tools abort startup", () => {
    expect(() =>
      resolveToolFilter({ allowed_tools: ["delete_pages"] }),
    ).toThrow(/unknown tool name/);
  });

  it("F2: unknown tool names in denied_tools abort startup", () => {
    expect(() =>
      resolveToolFilter({ denied_tools: ["update_spell"] }),
    ).toThrow(/unknown tool name/);
  });
});
