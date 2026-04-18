import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testConnection,
  verifyTenantIdentity,
  fetchTenantInfo,
} from "./test-connection.js";

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

describe("fetchTenantInfo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns cloudId and cloudName when response includes both", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        cloudId: "11111111-2222-3333-4444-555555555555",
        cloudName: "Globex Corp",
      }),
    } as any);

    const result = await fetchTenantInfo(
      "https://globex.atlassian.net",
      "user@test.com",
      "tok"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.cloudId).toBe("11111111-2222-3333-4444-555555555555");
      expect(result.info.displayName).toBe("Globex Corp");
    }
  });

  it("falls back to host-derived display name when cloudName is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cloudId: "cid-abc" }),
    } as any);

    const result = await fetchTenantInfo(
      "https://acme.atlassian.net",
      "u@x.com",
      "tok"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.cloudId).toBe("cid-abc");
      expect(result.info.displayName).toBe("acme");
    }
  });

  it("hits /_edge/tenant_info with Basic auth", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cloudId: "cid", cloudName: "Site" }),
    } as any);

    await fetchTenantInfo("https://s.atlassian.net/", "u@x.com", "tok");

    expect(spy).toHaveBeenCalledWith(
      "https://s.atlassian.net/_edge/tenant_info",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
        }),
      })
    );
  });

  it("returns not-ok when the response is missing cloudId", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cloudName: "Site with no id" }),
    } as any);

    const result = await fetchTenantInfo("https://x.atlassian.net", "u@x.com", "t");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("missing cloudId");
    }
  });

  it("returns not-ok when the endpoint returns a non-2xx status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as any);

    const result = await fetchTenantInfo("https://x.atlassian.net", "u@x.com", "t");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("404");
    }
  });

  it("returns not-ok on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await fetchTenantInfo("https://x.atlassian.net", "u@x.com", "t");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("tenant_info fetch failed");
    }
  });
});
