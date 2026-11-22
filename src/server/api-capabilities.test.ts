import { describe, expect, it } from "vitest";
import { FEATURES, capabilitiesFor, type Feature } from "./api-capabilities.js";

// Pinned exactly (contract C2). Changing a row is a product decision recorded
// against W-INV's results in plans/next-release-sdk2-and-v2-api.md §5.3; this
// test must be edited in the same commit.
const EXPECTED_GATEWAY: Record<Feature, boolean> = {
  "content.read": true,
  "content.write": true,
  "content.comments": true,
  "versions.read": true,
  "labels.read": true,
  "attachments.read": true,
  "attachments.upload": false,
  "attachments.download": false,
  "labels.write": false,
  "attribution.label": false,
  contentState: false,
  unverifiedBadge: false,
  "search.cql": false,
  recentChanges: false,
  pageByTitle: true,
  "users.byName": false,
  "users.byId": true,
  "writeProbe.spacePermissions": false,
  "writeProbe.dryRun": true,
  "badgeLocale.site": false,
};

describe("capabilitiesFor", () => {
  it("lists exactly the pinned features, with no duplicates", () => {
    expect([...FEATURES].sort()).toEqual(Object.keys(EXPECTED_GATEWAY).sort());
    expect(new Set(FEATURES).size).toBe(FEATURES.length);
  });

  it("site mode: every feature is available", () => {
    const site = capabilitiesFor("site");
    expect(site).toEqual(Object.fromEntries(FEATURES.map((f) => [f, true])));
  });

  it("gateway mode: matches the pinned table exactly", () => {
    expect(capabilitiesFor("gateway")).toEqual(EXPECTED_GATEWAY);
  });

  it("gateway mode: every v1-only or W-INV-pending row is unavailable", () => {
    const unavailable = FEATURES.filter((f) => !capabilitiesFor("gateway")[f]).sort();
    expect(unavailable).toEqual(
      [
        "attachments.upload",
        "attachments.download",
        "labels.write",
        "attribution.label",
        "contentState",
        "unverifiedBadge",
        "search.cql",
        "recentChanges",
        "users.byName",
        "writeProbe.spacePermissions",
        "badgeLocale.site",
      ].sort(),
    );
  });

  it("is deterministic and frozen (tools/list must not vary between calls)", () => {
    for (const mode of ["site", "gateway"] as const) {
      expect(capabilitiesFor(mode)).toBe(capabilitiesFor(mode));
      expect(Object.isFrozen(capabilitiesFor(mode))).toBe(true);
      expect(() => {
        (capabilitiesFor(mode) as Record<Feature, boolean>)["content.read"] = false;
      }).toThrow(TypeError);
    }
  });
});
