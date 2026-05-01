import { describe, it, expect, afterEach } from "vitest";
import {
  ProfileSettingsValidator,
  resolvePosture,
  resolveEffectivePosture,
  resolveUnverifiedStatusFlag,
  resolveUnverifiedStatusLocale,
} from "./config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("ProfileSettingsValidator", () => {
  it("accepts an empty object", () => {
    expect(() => ProfileSettingsValidator.parse({})).not.toThrow();
  });

  it("rejects unverifiedStatusName over 20 characters", () => {
    expect(() =>
      ProfileSettingsValidator.parse({ unverifiedStatusName: "A".repeat(21) })
    ).toThrow();
  });

  it("accepts unverifiedStatusName at exactly 20 characters", () => {
    expect(() =>
      ProfileSettingsValidator.parse({ unverifiedStatusName: "A".repeat(20) })
    ).not.toThrow();
  });

  it("rejects non-palette unverifiedStatusColor values", () => {
    expect(() =>
      ProfileSettingsValidator.parse({ unverifiedStatusColor: "#123456" })
    ).toThrow();
  });

  it("accepts each of the five palette colors", () => {
    for (const c of ["#FFC400", "#2684FF", "#57D9A3", "#FF7452", "#8777D9"]) {
      expect(() =>
        ProfileSettingsValidator.parse({ unverifiedStatusColor: c })
      ).not.toThrow();
    }
  });

  it("rejects invalid posture values", () => {
    expect(() => ProfileSettingsValidator.parse({ posture: "yolo" })).toThrow();
  });

  it("accepts each of the three posture values", () => {
    for (const p of ["read-only", "read-write", "detect"] as const) {
      expect(() => ProfileSettingsValidator.parse({ posture: p })).not.toThrow();
    }
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(() =>
      ProfileSettingsValidator.parse({ notAField: true } as unknown)
    ).toThrow();
  });
});

describe("resolvePosture", () => {
  it("returns 'detect' when nothing is set", () => {
    expect(resolvePosture(undefined)).toBe("detect");
    expect(resolvePosture({})).toBe("detect");
  });

  it("respects explicit posture: read-only / read-write / detect", () => {
    expect(resolvePosture({ posture: "read-only" })).toBe("read-only");
    expect(resolvePosture({ posture: "read-write" })).toBe("read-write");
    expect(resolvePosture({ posture: "detect" })).toBe("detect");
  });

  it("maps legacy readOnly: true → 'read-only'", () => {
    expect(resolvePosture({ readOnly: true })).toBe("read-only");
  });

  it("maps legacy readOnly: false → 'read-write'", () => {
    expect(resolvePosture({ readOnly: false })).toBe("read-write");
  });

  it("posture wins over readOnly when both are set", () => {
    expect(resolvePosture({ posture: "read-only", readOnly: false })).toBe("read-only");
    expect(resolvePosture({ posture: "read-write", readOnly: true })).toBe("read-write");
  });

  it("maps CONFLUENCE_READ_ONLY=true env → 'read-only' when nothing else is set", () => {
    process.env.CONFLUENCE_READ_ONLY = "true";
    expect(resolvePosture(undefined)).toBe("read-only");
  });

  it("maps CONFLUENCE_READ_ONLY=false env → 'read-write' when nothing else is set", () => {
    process.env.CONFLUENCE_READ_ONLY = "false";
    expect(resolvePosture(undefined)).toBe("read-write");
  });

  it("explicit profile posture wins over env var", () => {
    process.env.CONFLUENCE_READ_ONLY = "false";
    expect(resolvePosture({ posture: "read-only" })).toBe("read-only");
  });

  it("explicit profile readOnly wins over env var", () => {
    process.env.CONFLUENCE_READ_ONLY = "true";
    expect(resolvePosture({ readOnly: false })).toBe("read-write");
  });

  it("ignores unrecognized env values", () => {
    process.env.CONFLUENCE_READ_ONLY = "maybe";
    expect(resolvePosture(undefined)).toBe("detect");
  });
});

describe("resolveUnverifiedStatusFlag", () => {
  it("defaults to true", () => {
    expect(resolveUnverifiedStatusFlag(undefined)).toBe(true);
    expect(resolveUnverifiedStatusFlag({})).toBe(true);
  });

  it("respects explicit profile setting", () => {
    expect(resolveUnverifiedStatusFlag({ unverifiedStatus: false })).toBe(false);
    expect(resolveUnverifiedStatusFlag({ unverifiedStatus: true })).toBe(true);
  });

  it("reads env when profile unset", () => {
    process.env.CONFLUENCE_UNVERIFIED_STATUS = "false";
    expect(resolveUnverifiedStatusFlag(undefined)).toBe(false);
    process.env.CONFLUENCE_UNVERIFIED_STATUS = "true";
    expect(resolveUnverifiedStatusFlag(undefined)).toBe(true);
  });

  it("profile wins over env", () => {
    process.env.CONFLUENCE_UNVERIFIED_STATUS = "false";
    expect(resolveUnverifiedStatusFlag({ unverifiedStatus: true })).toBe(true);
  });
});

// =============================================================================
// resolveEffectivePosture — all 6 rows of the resolution matrix (Track O1)
// =============================================================================

describe("resolveEffectivePosture", () => {
  // Row 1: configured read-only, any probe → read-only / profile
  it("read-only + write probe → read-only, source: profile", () => {
    const result = resolveEffectivePosture("read-only", "write");
    expect(result).toEqual({ effective: "read-only", source: "profile" });
  });

  it("read-only + read-only probe → read-only, source: profile", () => {
    const result = resolveEffectivePosture("read-only", "read-only");
    expect(result).toEqual({ effective: "read-only", source: "profile" });
  });

  it("read-only + null probe → read-only, source: profile", () => {
    const result = resolveEffectivePosture("read-only", null);
    expect(result).toEqual({ effective: "read-only", source: "profile" });
  });

  // Row 2: configured read-write + probe says read-only → read-write / profile / warning
  it("read-write + read-only probe → read-write, source: profile, with warning", () => {
    const result = resolveEffectivePosture("read-write", "read-only");
    expect(result.effective).toBe("read-write");
    expect(result.source).toBe("profile");
    expect(result.warning).toMatch(/read-only/);
    expect(result.warning).toMatch(/writes will likely fail/);
  });

  // Row 3: configured read-write + any other probe → read-write / profile / no warning
  it("read-write + write probe → read-write, source: profile, no warning", () => {
    const result = resolveEffectivePosture("read-write", "write");
    expect(result.effective).toBe("read-write");
    expect(result.source).toBe("profile");
    expect(result.warning).toBeUndefined();
  });

  it("read-write + inconclusive probe → read-write, source: profile, no warning", () => {
    const result = resolveEffectivePosture("read-write", "inconclusive");
    expect(result.effective).toBe("read-write");
    expect(result.source).toBe("profile");
    expect(result.warning).toBeUndefined();
  });

  it("read-write + null probe → read-write, source: profile, no warning", () => {
    const result = resolveEffectivePosture("read-write", null);
    expect(result.effective).toBe("read-write");
    expect(result.source).toBe("profile");
    expect(result.warning).toBeUndefined();
  });

  // Row 4: configured detect + write probe → read-write / probe
  it("detect + write probe → read-write, source: probe", () => {
    const result = resolveEffectivePosture("detect", "write");
    expect(result).toEqual({ effective: "read-write", source: "probe" });
  });

  // Row 5: configured detect + read-only probe → read-only / probe
  it("detect + read-only probe → read-only, source: probe", () => {
    const result = resolveEffectivePosture("detect", "read-only");
    expect(result).toEqual({ effective: "read-only", source: "probe" });
  });

  // Row 6: configured detect + inconclusive → read-write / default / warning
  it("detect + inconclusive probe → read-write, source: default, with warning", () => {
    const result = resolveEffectivePosture("detect", "inconclusive");
    expect(result.effective).toBe("read-write");
    expect(result.source).toBe("default");
    expect(result.warning).toMatch(/inconclusive/);
    expect(result.warning).toMatch(/defaulting to read-write/);
  });

  // Row 7: configured detect + null → read-write / default / warning
  it("detect + null probe → read-write, source: default, with warning", () => {
    const result = resolveEffectivePosture("detect", null);
    expect(result.effective).toBe("read-write");
    expect(result.source).toBe("default");
    expect(result.warning).toMatch(/inconclusive/);
  });
});

describe("resolveUnverifiedStatusLocale", () => {
  it("returns undefined when nothing is set", () => {
    expect(resolveUnverifiedStatusLocale(undefined)).toBeUndefined();
    expect(resolveUnverifiedStatusLocale({})).toBeUndefined();
  });

  it("returns explicit profile locale", () => {
    expect(resolveUnverifiedStatusLocale({ unverifiedStatusLocale: "fr" })).toBe("fr");
  });

  it("falls through to env when profile unset", () => {
    process.env.CONFLUENCE_UNVERIFIED_STATUS_LOCALE = "de";
    expect(resolveUnverifiedStatusLocale(undefined)).toBe("de");
  });

  it("profile wins over env", () => {
    process.env.CONFLUENCE_UNVERIFIED_STATUS_LOCALE = "de";
    expect(resolveUnverifiedStatusLocale({ unverifiedStatusLocale: "ja" })).toBe("ja");
  });
});
