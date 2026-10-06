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

import {
  _rawUpdatePage,
  addLabels,
  createFooterComment,
  createInlineComment,
  deletePage,
  removeContentState,
  removeLabel,
  setContentState,
  uploadAttachment,
  WriteOutcomeUnknownError,
} from "./confluence-client.js";
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

describe("R1 outcome-unknown POSTs and side writes invalidate confirmation tokens", () => {
  const writes: Array<[string, () => Promise<unknown>]> = [
    ["createFooterComment", () => createFooterComment("30", "hi")],
    ["createInlineComment (reply)", () => createInlineComment("30", "hi", "text", 0, "77")],
    ["addLabels", () => addLabels("30", ["x"])],
    ["removeLabel", () => removeLabel("30", "x")],
    ["setContentState", () => setContentState("30", "AI-edited", "#FFC400")],
    ["removeContentState", () => removeContentState("30")],
    ["uploadAttachment", () => uploadAttachment("30", Buffer.from("x"), "f.txt")],
  ];

  it.each(writes)("%s: a lost request invalidates the parent page's tokens, and only that page's", async (_name, write) => {
    const mine = mintToken(ctx("30"));
    const other = mintToken(ctx("31"));
    pageCache.set("30", 5, "<p>cached</p>");

    await expect(write()).rejects.toBeInstanceOf(WriteOutcomeUnknownError);

    expect(seen.some((m) => m.outcome === "stale" && m.auditId === mine.auditId)).toBe(true);
    expect(seen.some((m) => m.auditId === other.auditId)).toBe(false);
    expect(pageCache.has("30")).toBeUndefined();
  });

  it("a definite failure (500) on a comment POST leaves the tokens alone", async () => {
    global.fetch = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    const t = mintToken(ctx("30"));
    await expect(createFooterComment("30", "hi")).rejects.not.toBeInstanceOf(WriteOutcomeUnknownError);
    expect(seen.some((m) => m.auditId === t.auditId)).toBe(false);
  });
});
