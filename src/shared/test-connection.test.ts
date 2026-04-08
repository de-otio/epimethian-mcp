import { describe, it, expect, beforeEach, vi } from "vitest";
import { testConnection, verifyTenantIdentity } from "./test-connection.js";

describe("testConnection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success with space name on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ name: "Engineering" }] }),
    } as any);

    const result = await testConnection(
      "https://x.atlassian.net",
      "a@b.com",
      "tok"
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Connected");
    expect(result.message).toContain("Engineering");
  });

  it("returns failure with 'invalid or expired' on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as any);

    const result = await testConnection(
      "https://x.atlassian.net",
      "a@b.com",
      "bad"
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("invalid or expired");
  });

  it("returns failure with HTTP status on other errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    } as any);

    const result = await testConnection(
      "https://x.atlassian.net",
      "a@b.com",
      "tok"
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("403");
  });

  it("returns failure with 'Connection failed' on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED")
    );

    const result = await testConnection(
      "https://x.atlassian.net",
      "a@b.com",
      "tok"
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Connection failed");
  });

  it("strips trailing slashes from url", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    } as any);

    await testConnection("https://x.atlassian.net///", "a@b.com", "tok");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://x.atlassian.net/wiki/api/v2/spaces?limit=1",
      expect.any(Object)
    );
  });
});

describe("verifyTenantIdentity", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok when email matches", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ email: "user@test.com", displayName: "User" }),
    } as any);

    const result = await verifyTenantIdentity(
      "https://x.atlassian.net",
      "user@test.com",
      "tok"
    );

    expect(result.ok).toBe(true);
    expect(result.authenticatedEmail).toBe("user@test.com");
  });

  it("returns ok for case-insensitive email match", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ email: "User@Test.COM" }),
    } as any);

    const result = await verifyTenantIdentity(
      "https://x.atlassian.net",
      "user@test.com",
      "tok"
    );

    expect(result.ok).toBe(true);
  });

  it("returns not-ok on email mismatch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ email: "other@wrong.com" }),
    } as any);

    const result = await verifyTenantIdentity(
      "https://x.atlassian.net",
      "user@test.com",
      "tok"
    );

    expect(result.ok).toBe(false);
    expect(result.authenticatedEmail).toBe("other@wrong.com");
    expect(result.message).toContain("mismatch");
  });

  it("returns not-ok on HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as any);

    const result = await verifyTenantIdentity(
      "https://x.atlassian.net",
      "user@test.com",
      "tok"
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("401");
  });

  it("returns not-ok on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED")
    );

    const result = await verifyTenantIdentity(
      "https://x.atlassian.net",
      "user@test.com",
      "tok"
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Identity verification failed");
  });
});
