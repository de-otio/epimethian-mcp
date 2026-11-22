import { describe, expect, it } from "vitest";
import { registeredToolsFor, WRITE_TOOLS } from "./tool-posture.js";
import { KNOWN_TOOLS } from "./tool-allowlist.js";
import { unavailableToolsFor } from "./api-capabilities.js";

describe("registeredToolsFor", () => {
  it("gateway, read-only: the 14 tools seen live (2026-11-22)", () => {
    expect([...registeredToolsFor("gateway", "read-only")].sort()).toEqual(
      [
        "get_page",
        "list_pages",
        "get_page_children",
        "get_spaces",
        "check_permissions",
        "get_page_by_title",
        "get_attachments",
        "get_labels",
        "get_comments",
        "get_page_versions",
        "get_page_version",
        "diff_page_versions",
        "get_version",
        "upgrade",
      ].sort(),
    );
  });

  it("gateway, read-write: every known tool the gateway can serve (28)", () => {
    const hidden = new Set(unavailableToolsFor("gateway"));
    expect(registeredToolsFor("gateway", "read-write")).toEqual(KNOWN_TOOLS.filter((t) => !hidden.has(t)));
    expect(registeredToolsFor("gateway", "read-write")).toHaveLength(28);
  });

  it("site: read-write is every known tool; read-only drops exactly the write tools", () => {
    expect(registeredToolsFor("site", "read-write")).toEqual([...KNOWN_TOOLS]);
    expect(registeredToolsFor("site", "read-only")).toEqual(KNOWN_TOOLS.filter((t) => !WRITE_TOOLS.has(t)));
  });
});
