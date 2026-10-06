/**
 * R1, sealed-tenant half: an unknown-outcome write must invalidate the soft
 * confirmation tokens minted for that page. That needs a profile with a sealed
 * cloudId, which the env-var credential mode of http-policy.test.ts lacks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_PROFILE = "test-profile";
  delete process.env.CONFLUENCE_URL;
  delete process.env.CONFLUENCE_EMAIL;
  delete process.env.CONFLUENCE_API_TOKEN;
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue({
    url: "https://test.atlassian.net",
    email: "user@test.com",
    apiToken: "test-token",
    cloudId: "cloud-sealed-1",
    tenantDisplayName: "Example Tenant",
  }),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

vi.mock("../shared/profiles.js", () => ({
  getProfileSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../shared/test-connection.js", () => ({
  testConnection: vi.fn().mockResolvedValue({ ok: true, message: "Connected" }),
  verifyTenantIdentity: vi.fn().mockResolvedValue({ ok: true, authenticatedEmail: "user@test.com", message: "Verified" }),
}));

import { _rawUpdatePage, deletePage, WriteOutcomeUnknownError } from "./confluence-client.js";
import { mintToken, onValidate, _resetForTest, type AuditValidateMeta } from "./confirmation-tokens.js";
import { pageCache } from "./page-cache.js";

function ctx(pageId: string) {
  return {
    tool: "update_page",
    cloudId: "cloud-sealed-1",
    pageId,
    pageVersion: 5,
    diffHash: "hash-" + pageId,
  };
}

let seen: AuditValidateMeta[];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  pageCache.clear();
  _resetForTest();
  seen = [];
  onValidate((m) => seen.push(m));
  global.fetch = vi.fn(async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
});

describe("R1 outcome-unknown invalidates confirmation tokens", () => {
  it("a lost PUT invalidates every token minted for that page, and only that page", async () => {
    const mine = mintToken(ctx("30"));
    const other = mintToken(ctx("31"));

    await expect(_rawUpdatePage("30", { title: "T", version: 5 })).rejects.toBeInstanceOf(WriteOutcomeUnknownError);

    expect(seen.some((m) => m.outcome === "stale" && m.auditId === mine.auditId)).toBe(true);
    expect(seen.some((m) => m.auditId === other.auditId)).toBe(false);
  });

  it("a lost DELETE invalidates the page's tokens", async () => {
    const t = mintToken(ctx("30"));
    await expect(deletePage("30")).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
    expect(seen.some((m) => m.outcome === "stale" && m.auditId === t.auditId)).toBe(true);
  });

  it("a 2xx PUT with an unreadable page body invalidates the tokens too", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof fetch;
    const t = mintToken(ctx("30"));
    await expect(_rawUpdatePage("30", { title: "T", version: 5 })).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
    expect(seen.some((m) => m.outcome === "stale" && m.auditId === t.auditId)).toBe(true);
  });
});
