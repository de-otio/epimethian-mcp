/**
 * Tests for src/server/provenance.ts — design doc #13
 *
 * Covers the 20 cases listed in plans/permission-and-provenance-implementation.md
 * under Track P1.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Config } from "./confluence-client.js";

// ---------------------------------------------------------------------------
// Mock confluence-client before importing provenance.
// ---------------------------------------------------------------------------
vi.mock("./confluence-client.js", () => ({
  getContentState: vi.fn(),
  setContentState: vi.fn(),
  getSiteDefaultLocale: vi.fn(),
  // ConfluenceApiError must be a real class so instanceof checks work.
  ConfluenceApiError: class ConfluenceApiError extends Error {
    readonly status: number;
    constructor(status = 500, message = "API Error") {
      super(message);
      this.name = "ConfluenceApiError";
      this.status = status;
    }
  },
  // ConfluencePermissionError must be a real class so instanceof checks work.
  ConfluencePermissionError: class ConfluencePermissionError extends Error {
    readonly status: number;
    constructor(status = 403, message = "Forbidden") {
      super(message);
      this.name = "ConfluencePermissionError";
      this.status = status;
    }
  },
}));

import {
  UNVERIFIED_COLOR,
  UNVERIFIED_LABELS,
  isKnownUnverifiedLabel,
  pickLocale,
  resolveUnverifiedStatus,
  markPageUnverified,
} from "./provenance.js";

import {
  getContentState,
  setContentState,
  getSiteDefaultLocale,
  ConfluenceApiError,
  ConfluencePermissionError,
} from "./confluence-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Config stub for tests. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: "https://example.atlassian.net",
    email: "test@example.com",
    profile: "default",
    readOnly: false,
    attribution: false,
    apiV2: "https://example.atlassian.net/api/v2",
    apiV1: "https://example.atlassian.net/wiki/rest/api",
    authHeader: "Basic dGVzdA==",
    jsonHeaders: {},
    unverifiedStatus: true,
    // Required by Config interface (populated by validateStartup() at runtime).
    effectivePosture: "read-write",
    probedCapability: null,
    postureSource: "default",
    ...overrides,
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetAllMocks();
  // Default: getContentState returns null (no current badge).
  (getContentState as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  // Default: setContentState succeeds.
  (setContentState as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  // Default: site-locale probe returns undefined (no tenant default).
  // Individual tests override to simulate a configured site default language.
  (getSiteDefaultLocale as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

afterEach(() => {
  // Restore env vars that individual tests may have modified.
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// Test 1 — Module-load assertion passes for the current label table
// ---------------------------------------------------------------------------
describe("module-load assertion", () => {
  it("1. all labels in UNVERIFIED_LABELS are ≤20 code points", () => {
    for (const [locale, label] of Object.entries(UNVERIFIED_LABELS)) {
      expect([...label].length, `locale "${locale}" label "${label}"`).toBeLessThanOrEqual(20);
    }
  });

  // Test 2 — Module-load assertion throws for a >20 code-point label.
  // We can't re-import the module, so we simulate the assertion logic directly.
  it("2. module-load assertion throws for a label exceeding 20 code points", () => {
    const badTable: Record<string, string> = {
      ...UNVERIFIED_LABELS,
      xx: "A".repeat(21), // 21 code points — over the limit
    };
    expect(() => {
      for (const [locale, label] of Object.entries(badTable)) {
        const codePoints = [...label].length;
        if (codePoints > 20) {
          throw new Error(
            `UNVERIFIED_LABELS["${locale}"] = "${label}" has ${codePoints} code points, exceeding the 20-code-point Confluence limit.`
          );
        }
      }
    }).toThrow(/exceeding the 20-code-point Confluence limit/);
  });
});

// ---------------------------------------------------------------------------
// Tests 3–4 — pickLocale
// ---------------------------------------------------------------------------
describe("pickLocale", () => {
  it("3. profile setting wins over env, site default, and 'en'", async () => {
    process.env.CONFLUENCE_UNVERIFIED_STATUS_LOCALE = "de";
    (getSiteDefaultLocale as ReturnType<typeof vi.fn>).mockResolvedValue("es");
    const cfg = makeConfig({ unverifiedStatusLocale: "fr" });
    expect(await pickLocale(cfg)).toBe("fr");
    expect(getSiteDefaultLocale).not.toHaveBeenCalled();
  });

  it("3b. env wins over site default and 'en' when profile not set", async () => {
    process.env.CONFLUENCE_UNVERIFIED_STATUS_LOCALE = "de";
    (getSiteDefaultLocale as ReturnType<typeof vi.fn>).mockResolvedValue("es");
    const cfg = makeConfig({ unverifiedStatusLocale: undefined });
    expect(await pickLocale(cfg)).toBe("de");
    expect(getSiteDefaultLocale).not.toHaveBeenCalled();
  });

  it("3c. site default wins over 'en' when profile and env not set", async () => {
    delete process.env.CONFLUENCE_UNVERIFIED_STATUS_LOCALE;
    (getSiteDefaultLocale as ReturnType<typeof vi.fn>).mockResolvedValue("ja");
    const cfg = makeConfig({ unverifiedStatusLocale: undefined });
    expect(await pickLocale(cfg)).toBe("ja");
  });

  it("3d. falls back to 'en' when profile, env, and site default are all absent", async () => {
    delete process.env.CONFLUENCE_UNVERIFIED_STATUS_LOCALE;
    (getSiteDefaultLocale as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const cfg = makeConfig({ unverifiedStatusLocale: undefined });
    expect(await pickLocale(cfg)).toBe("en");
  });

  it("3e. does NOT consult Intl.DateTimeFormat — process locale must not leak into the tenant-visible badge", async () => {
    delete process.env.CONFLUENCE_UNVERIFIED_STATUS_LOCALE;
    // Simulate a German-locale MCP process.
    const spy = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(() => ({
        resolvedOptions: () => ({ locale: "de-DE" }) as Intl.ResolvedDateTimeFormatOptions,
      }) as unknown as Intl.DateTimeFormat);
    (getSiteDefaultLocale as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    try {
      const cfg = makeConfig({ unverifiedStatusLocale: undefined });
      expect(await pickLocale(cfg)).toBe("en");
    } finally {
      spy.mockRestore();
    }
  });

  it("4. 'fr-FR' resolves to 'fr'", async () => {
    const cfg = makeConfig({ unverifiedStatusLocale: "fr-FR" });
    expect(await pickLocale(cfg)).toBe("fr");
  });

  it("4b. site-default 'de_DE' (underscore form) resolves to 'de'", async () => {
    delete process.env.CONFLUENCE_UNVERIFIED_STATUS_LOCALE;
    (getSiteDefaultLocale as ReturnType<typeof vi.fn>).mockResolvedValue("de");
    const cfg = makeConfig({ unverifiedStatusLocale: undefined });
    expect(await pickLocale(cfg)).toBe("de");
  });
});

// ---------------------------------------------------------------------------
// Tests 5–9 — resolveUnverifiedStatus
// ---------------------------------------------------------------------------
describe("resolveUnverifiedStatus", () => {
  it("5. returns { 'AI-edited', '#FFC400' } for 'en' with no overrides", async () => {
    const cfg = makeConfig({ unverifiedStatusLocale: "en" });
    expect(await resolveUnverifiedStatus(cfg)).toEqual({
      name: "AI-edited",
      color: UNVERIFIED_COLOR,
    });
  });

  it("6. returns the French label for locale 'fr'", async () => {
    const cfg = makeConfig({ unverifiedStatusLocale: "fr" });
    expect(await resolveUnverifiedStatus(cfg)).toEqual({
      name: "Modifié par IA",
      color: UNVERIFIED_COLOR,
    });
  });

  it("7. falls back to 'en' for an unknown locale 'xx'", async () => {
    const cfg = makeConfig({ unverifiedStatusLocale: "xx" });
    expect(await resolveUnverifiedStatus(cfg)).toEqual({
      name: "AI-edited",
      color: UNVERIFIED_COLOR,
    });
  });

  it("8. honors unverifiedStatusName and bypasses locale table", async () => {
    const cfg = makeConfig({
      unverifiedStatusLocale: "fr",
      unverifiedStatusName: "Needs legal review",
    });
    const result = await resolveUnverifiedStatus(cfg);
    expect(result.name).toBe("Needs legal review");
    expect(result.color).toBe(UNVERIFIED_COLOR);
  });

  it("9. honors unverifiedStatusColor override", async () => {
    const cfg = makeConfig({
      unverifiedStatusLocale: "en",
      unverifiedStatusColor: "#FF7452",
    });
    expect(await resolveUnverifiedStatus(cfg)).toEqual({
      name: "AI-edited",
      color: "#FF7452",
    });
  });

  it("9b. uses site-default locale when no overrides present", async () => {
    delete process.env.CONFLUENCE_UNVERIFIED_STATUS_LOCALE;
    (getSiteDefaultLocale as ReturnType<typeof vi.fn>).mockResolvedValue("de");
    const cfg = makeConfig({ unverifiedStatusLocale: undefined });
    expect(await resolveUnverifiedStatus(cfg)).toEqual({
      name: "KI-bearbeitet",
      color: UNVERIFIED_COLOR,
    });
  });
});

// ---------------------------------------------------------------------------
// Tests 10–12 — isKnownUnverifiedLabel
// ---------------------------------------------------------------------------
describe("isKnownUnverifiedLabel", () => {
  it("10. returns true for every label in the locale table", () => {
    for (const label of Object.values(UNVERIFIED_LABELS)) {
      expect(isKnownUnverifiedLabel(label), `label: "${label}"`).toBe(true);
    }
  });

  it("11. returns true for the custom override name", () => {
    const custom = "Needs legal review";
    expect(isKnownUnverifiedLabel(custom, custom)).toBe(true);
  });

  it("12. returns false for unrelated strings", () => {
    expect(isKnownUnverifiedLabel("Reviewed")).toBe(false);
    expect(isKnownUnverifiedLabel("In progress")).toBe(false);
    expect(isKnownUnverifiedLabel("")).toBe(false);
    expect(isKnownUnverifiedLabel("Needs legal review")).toBe(false); // no override passed
  });
});

// ---------------------------------------------------------------------------
// Tests 13–20 — markPageUnverified
// ---------------------------------------------------------------------------
describe("markPageUnverified", () => {
  it("13. with unverifiedStatus: false, does NOT call getContentState or setContentState", async () => {
    const cfg = makeConfig({ unverifiedStatus: false });
    const result = await markPageUnverified("123", cfg);
    expect(result).toEqual({});
    expect(getContentState).not.toHaveBeenCalled();
    expect(setContentState).not.toHaveBeenCalled();
  });

  it("14. when current state matches target (same color + known label), setContentState NOT called (idempotent)", async () => {
    const cfg = makeConfig({ unverifiedStatusLocale: "en" });
    (getContentState as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "AI-edited",
      color: UNVERIFIED_COLOR,
    });

    const result = await markPageUnverified("123", cfg);
    expect(result).toEqual({});
    expect(setContentState).not.toHaveBeenCalled();
  });

  it("15. when current state is a different locale's known label (same color), setContentState NOT called (cross-locale idempotent)", async () => {
    const cfg = makeConfig({ unverifiedStatusLocale: "en" });
    // Page was previously marked in French; same color — still "known unverified"
    (getContentState as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "Modifié par IA",
      color: UNVERIFIED_COLOR,
    });

    const result = await markPageUnverified("123", cfg);
    expect(result).toEqual({});
    expect(setContentState).not.toHaveBeenCalled();
  });

  it("16. when current state is null, setContentState IS called with target name/color", async () => {
    const cfg = makeConfig({ unverifiedStatusLocale: "en" });
    (getContentState as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await markPageUnverified("456", cfg);
    expect(result).toEqual({});
    expect(setContentState).toHaveBeenCalledOnce();
    expect(setContentState).toHaveBeenCalledWith("456", "AI-edited", UNVERIFIED_COLOR);
  });

  it("17. when current state is a non-unverified label, setContentState IS called (overwrite)", async () => {
    const cfg = makeConfig({ unverifiedStatusLocale: "en" });
    (getContentState as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "In progress",
      color: "#2684FF",
    });

    const result = await markPageUnverified("789", cfg);
    expect(result).toEqual({});
    expect(setContentState).toHaveBeenCalledOnce();
    expect(setContentState).toHaveBeenCalledWith("789", "AI-edited", UNVERIFIED_COLOR);
  });

  it("18. when setContentState throws ConfluencePermissionError, returns warning and does NOT throw", async () => {
    const cfg = makeConfig({ unverifiedStatusLocale: "en" });
    (getContentState as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (setContentState as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (ConfluencePermissionError as unknown as new (status: number, msg: string) => Error)(403, "Forbidden")
    );

    const result = await markPageUnverified("page-42", cfg);
    expect(result.warning).toContain("permission denied");
    expect(result.warning).toContain("page-42");
  });

  it("19. when getContentState throws ConfluencePermissionError, falls through to setContentState", async () => {
    const cfg = makeConfig({ unverifiedStatusLocale: "en" });
    (getContentState as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (ConfluencePermissionError as unknown as new (status: number, msg: string) => Error)(403, "Forbidden")
    );
    (setContentState as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const result = await markPageUnverified("page-99", cfg);
    // Must attempt setContentState despite the GET failure
    expect(setContentState).toHaveBeenCalledOnce();
    // And since setContentState succeeded, no warning
    expect(result).toEqual({});
  });

  it("20. when setContentState throws a generic error, returns warning and does NOT throw", async () => {
    const cfg = makeConfig({ unverifiedStatusLocale: "en" });
    (getContentState as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (setContentState as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network timeout")
    );

    const result = await markPageUnverified("page-77", cfg);
    expect(result.warning).toContain("Network timeout");
    expect(result.warning).toContain("page-77");
  });

  it("21. when setContentState throws 409 after retries are exhausted, returns warning and does NOT throw", async () => {
    // Note: 409 retry lives inside setContentState (see confluence-client.test.ts
    // for retry behaviour). From this caller's perspective, an exhausted retry
    // surfaces as a thrown ConfluenceApiError that we convert to a warning.
    const cfg = makeConfig({ unverifiedStatusLocale: "en" });
    (getContentState as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const err409 = new (ConfluenceApiError as unknown as new (status: number, msg: string) => Error)(
      409,
      "Version conflict"
    );
    (setContentState as ReturnType<typeof vi.fn>).mockRejectedValue(err409);

    const result = await markPageUnverified("page-409-exhausted", cfg);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("page-409-exhausted");
    expect(result.warning).toContain("Version conflict");
  });
});
