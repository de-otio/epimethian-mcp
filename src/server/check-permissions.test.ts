import { describe, it, expect } from "vitest";
import { buildCheckPermissionsPayload } from "./check-permissions.js";
import type { Config } from "./confluence-client.js";

/** Minimal valid Config with all O1-era fields populated. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: "https://test.atlassian.net",
    email: "user@test.com",
    profile: "my-profile",
    readOnly: false,
    attribution: true,
    posture: "read-write",
    effectivePosture: "read-write",
    probedCapability: null,
    postureSource: "default",
    apiV2: "https://test.atlassian.net/wiki/api/v2",
    apiV1: "https://test.atlassian.net/wiki/rest/api",
    authHeader: "Basic dGVzdA==",
    jsonHeaders: {},
    ...overrides,
  } as Config;
}

// ---------------------------------------------------------------------------
// Test 1 — read-only profile + read-only probe
// ---------------------------------------------------------------------------
describe("buildCheckPermissionsPayload", () => {
  it("1: read-only profile + read-only probe → correct posture, writePages false, both-read-only note", () => {
    const cfg = makeConfig({
      readOnly: true,
      posture: "read-only",
      effectivePosture: "read-only",
      probedCapability: "read-only",
      postureSource: "profile",
    });

    const payload = buildCheckPermissionsPayload(cfg);

    expect(payload.posture.effective).toBe("read-only");
    expect(payload.posture.configured).toBe("read-only");
    expect(payload.posture.source).toBe("profile");
    expect(payload.tokenCapability.writePages).toBe(false);
    expect(payload.notes).toHaveLength(1);
    expect(payload.notes[0]).toContain("Both the profile and the token are read-only");
  });

  // ---------------------------------------------------------------------------
  // Test 2 — write-capable token + read-only profile (user-pinned)
  // ---------------------------------------------------------------------------
  it("2: write-capable probe + read-only profile → effective read-only, writePages true, user-pinning note", () => {
    const cfg = makeConfig({
      readOnly: true,
      posture: "read-only",
      effectivePosture: "read-only",
      probedCapability: "write",
      postureSource: "profile",
    });

    const payload = buildCheckPermissionsPayload(cfg);

    expect(payload.posture.effective).toBe("read-only");
    expect(payload.posture.configured).toBe("read-only");
    expect(payload.posture.source).toBe("profile");
    expect(payload.tokenCapability.writePages).toBe(true);
    expect(payload.notes).toHaveLength(1);
    expect(payload.notes[0]).toContain("pinned to read-only mode by user configuration");
    expect(payload.notes[0]).toContain("write tools are not exposed to the agent");
  });

  // ---------------------------------------------------------------------------
  // Test 3 — write-capable token + read-write profile
  // ---------------------------------------------------------------------------
  it("3: write-capable probe + read-write profile → effective read-write, writePages true, no warning note", () => {
    const cfg = makeConfig({
      readOnly: false,
      posture: "read-write",
      effectivePosture: "read-write",
      probedCapability: "write",
      postureSource: "profile",
    });

    const payload = buildCheckPermissionsPayload(cfg);

    expect(payload.posture.effective).toBe("read-write");
    expect(payload.posture.configured).toBe("read-write");
    expect(payload.posture.source).toBe("profile");
    expect(payload.tokenCapability.writePages).toBe(true);
    // No mismatch, no notes
    expect(payload.notes).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 4 — read-only probe + read-write profile (mismatch → WARNING)
  // ---------------------------------------------------------------------------
  it("4: read-only probe + read-write profile → effective read-write, writePages false, WARNING note", () => {
    const cfg = makeConfig({
      readOnly: false,
      posture: "read-write",
      effectivePosture: "read-write",
      probedCapability: "read-only",
      postureSource: "profile",
    });

    const payload = buildCheckPermissionsPayload(cfg);

    expect(payload.posture.effective).toBe("read-write");
    expect(payload.posture.configured).toBe("read-write");
    expect(payload.posture.source).toBe("profile");
    expect(payload.tokenCapability.writePages).toBe(false);
    expect(payload.notes).toHaveLength(1);
    expect(payload.notes[0]).toContain("WARNING");
    expect(payload.notes[0]).toContain("Writes will likely fail");
  });

  // ---------------------------------------------------------------------------
  // Test 5 — source "probe" when posture was detected by probe
  // ---------------------------------------------------------------------------
  it("5: source is 'probe' when posture was resolved by probe", () => {
    const cfg = makeConfig({
      posture: "detect",
      effectivePosture: "read-write",
      probedCapability: "write",
      postureSource: "probe",
    });

    const payload = buildCheckPermissionsPayload(cfg);

    expect(payload.posture.source).toBe("probe");
    expect(payload.posture.configured).toBe("detect");
    expect(payload.posture.effective).toBe("read-write");
  });

  // ---------------------------------------------------------------------------
  // Test 6 — source "profile" when user pinned posture
  // ---------------------------------------------------------------------------
  it("6: source is 'profile' when user explicitly configured posture", () => {
    const cfg = makeConfig({
      posture: "read-only",
      effectivePosture: "read-only",
      probedCapability: null,
      postureSource: "profile",
    });

    const payload = buildCheckPermissionsPayload(cfg);

    expect(payload.posture.source).toBe("profile");
  });

  // ---------------------------------------------------------------------------
  // Test 7 — source "default" when probe was inconclusive or null+detect
  // ---------------------------------------------------------------------------
  it("7a: source is 'default' when probe was inconclusive", () => {
    const cfg = makeConfig({
      posture: "detect",
      effectivePosture: "read-write",
      probedCapability: "inconclusive",
      postureSource: "default",
    });

    const payload = buildCheckPermissionsPayload(cfg);

    expect(payload.posture.source).toBe("default");
    expect(payload.tokenCapability.writePages).toBe("unknown");
  });

  it("7b: source is 'default' when probedCapability is null and posture was 'detect'", () => {
    const cfg = makeConfig({
      posture: "detect",
      effectivePosture: "read-write",
      probedCapability: null,
      postureSource: "default",
    });

    const payload = buildCheckPermissionsPayload(cfg);

    expect(payload.posture.source).toBe("default");
    expect(payload.tokenCapability.writePages).toBe("unknown");
  });

  // ---------------------------------------------------------------------------
  // Structural / invariant checks
  // ---------------------------------------------------------------------------
  it("always includes static capability fields with expected values", () => {
    const cfg = makeConfig();
    const payload = buildCheckPermissionsPayload(cfg);

    expect(payload.tokenCapability.authenticated).toBe(true);
    expect(payload.tokenCapability.listSpaces).toBe(true);
    expect(payload.tokenCapability.readPages).toBe(true);
    expect(payload.tokenCapability.addLabels).toBe("unknown");
    expect(payload.tokenCapability.setContentState).toBe("unknown");
    expect(payload.tokenCapability.addAttachments).toBe("unknown");
    expect(payload.tokenCapability.addComments).toBe("unknown");
  });

  it("returns the correct profile and user email", () => {
    const cfg = makeConfig({ profile: "staging", email: "dev@example.com" });
    const payload = buildCheckPermissionsPayload(cfg);

    expect(payload.profile).toBe("staging");
    expect(payload.user.email).toBe("dev@example.com");
  });

  it("handles null profile gracefully", () => {
    const cfg = makeConfig({ profile: null });
    const payload = buildCheckPermissionsPayload(cfg);

    expect(payload.profile).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Fallback-branch coverage (lines 40-47): effectivePosture / posture /
  // postureSource undefined (pre-O1 test-fixture pattern).
  // ---------------------------------------------------------------------------
  it("falls back to read-write when effectivePosture is undefined", () => {
    const cfg = {
      ...makeConfig(),
      effectivePosture: undefined,
      posture: undefined,
      postureSource: undefined,
    } as unknown as Config;

    const payload = buildCheckPermissionsPayload(cfg);

    expect(payload.posture.effective).toBe("read-write");
    expect(payload.posture.configured).toBe("read-write");
    expect(payload.posture.source).toBe("default");
  });

  it("falls back configured to effectivePosture when posture is undefined but effectivePosture is set", () => {
    const cfg = {
      ...makeConfig(),
      posture: undefined,
      effectivePosture: "read-write" as const,
      postureSource: "probe" as const,
    } as unknown as Config;

    const payload = buildCheckPermissionsPayload(cfg);

    // configured falls back to effectivePosture
    expect(payload.posture.configured).toBe("read-write");
    expect(payload.posture.effective).toBe("read-write");
  });
});
