import { describe, expect, it } from "vitest";
import { ProfileSettingsValidator } from "./config.js";
import { resolveReadScope } from "./read-scope.js";

const ZWSP = "\u200B";

function failure(settings: Parameters<typeof resolveReadScope>[0]): string {
  const r = resolveReadScope(settings);
  if (r.ok) throw new Error("expected invalid settings");
  return r.error;
}

describe("resolveReadScope", () => {
  it("is a no-op for a profile without read-scope settings", () => {
    for (const settings of [undefined, {}, { spaces: ["DOCS"] }]) {
      const r = resolveReadScope(settings);
      expect(r).toEqual({ ok: true, readSpaces: undefined, enforced: false, redactor: undefined });
    }
  });

  it("returns the scope, the enforced flag and a working redactor", () => {
    const r = resolveReadScope({
      read_spaces: ["DOCS", "TEAM", "DOCS"],
      read_spaces_enforced: true,
      redact_patterns: ["project falcon"],
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.readSpaces).toEqual(["DOCS", "TEAM"]);
    expect(r.enforced).toBe(true);
    expect(r.redactor?.("about Project Falcon")).toBe("about [redacted]");
  });

  it("keeps an empty read_spaces list (nothing searchable by default)", () => {
    const r = resolveReadScope({ read_spaces: [] });
    expect(r).toMatchObject({ ok: true, readSpaces: [] });
  });

  it("rejects malformed read_spaces and names the field", () => {
    expect(failure({ read_spaces: "DOCS" as unknown as string[] })).toContain("read_spaces");
    expect(failure({ read_spaces: [""] })).toContain("read_spaces");
    expect(failure({ read_spaces: ["DO\nCS"] })).toContain("read_spaces");
    expect(failure({ read_spaces: Array.from({ length: 101 }, (_, i) => `S${i}`) })).toContain(
      "read_spaces",
    );
  });

  it("rejects read_spaces_enforced without read_spaces", () => {
    expect(failure({ read_spaces_enforced: true })).toContain("requires `read_spaces`");
  });

  it("rejects out-of-bounds redact_patterns without echoing them", () => {
    const secret = "S".repeat(201);
    const tooLong = failure({ redact_patterns: [secret] });
    expect(tooLong).toContain("redact_patterns");
    expect(tooLong).not.toContain(secret);

    expect(failure({ redact_patterns: [""] })).toContain("redact_patterns");
    expect(
      failure({ redact_patterns: Array.from({ length: 101 }, (_, i) => `p${i}`) }),
    ).toContain("redact_patterns");
  });

  it("rejects a pattern that normalises to nothing (it would match everywhere)", () => {
    const message = failure({ redact_patterns: ["zzqpattern", `${ZWSP}${ZWSP}`] });
    expect(message).toContain("redact_patterns");
    expect(message).not.toContain("zzqpattern");
  });

  it("marks invalid settings as disabling search", () => {
    expect(failure({ read_spaces_enforced: true })).toContain("Search is disabled");
  });
});

describe("ProfileSettingsValidator read-scope fields", () => {
  it("accepts the new keys within bounds", () => {
    expect(() =>
      ProfileSettingsValidator.parse({
        read_spaces: ["DOCS"],
        read_spaces_enforced: true,
        redact_patterns: ["x"],
      }),
    ).not.toThrow();
  });

  it("rejects out-of-bounds values", () => {
    expect(() => ProfileSettingsValidator.parse({ read_spaces: [""] })).toThrow();
    expect(() => ProfileSettingsValidator.parse({ read_spaces_enforced: "yes" })).toThrow();
    expect(() => ProfileSettingsValidator.parse({ redact_patterns: ["a".repeat(201)] })).toThrow();
  });
});
