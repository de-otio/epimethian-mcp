/**
 * Gateway-mode behaviour of the shared connection helpers: the tenant probe
 * carries no credential, the spaces check goes to the pinned gateway base, and
 * the setup-time write probe reports only a status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bodySaysScopeMismatch, classifyScopeProbe } from "./gateway-scopes.js";
import { fetchTenantInfo, probeGatewayWriteScope, testConnection } from "./test-connection.js";

const CLOUD_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const GATEWAY = `https://api.atlassian.com/ex/confluence/${CLOUD_ID}`;

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => vi.restoreAllMocks());

const headersOf = (call: unknown[]) => (call[1] as { headers: Record<string, string> }).headers;

describe("fetchTenantInfo", () => {
  const ok = () => ({ ok: true, status: 200, json: async () => ({ cloudId: CLOUD_ID, cloudName: "Example" }) }) as never;

  it("gateway mode (authenticated: false) sends no Authorization header to the site origin", async () => {
    fetchSpy.mockResolvedValue(ok());
    const r = await fetchTenantInfo("https://example.atlassian.net", "u@example.com", "scoped-secret", {
      authenticated: false,
    });
    expect(r).toEqual({ ok: true, info: { cloudId: CLOUD_ID, displayName: "Example" } });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://example.atlassian.net/_edge/tenant_info");
    expect(Object.keys(headersOf(fetchSpy.mock.calls[0])).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(JSON.stringify(fetchSpy.mock.calls[0])).not.toContain("scoped-secret");
  });

  it("site mode still sends Basic auth, unchanged", async () => {
    fetchSpy.mockResolvedValue(ok());
    await fetchTenantInfo("https://example.atlassian.net", "u@example.com", "tok");
    expect(headersOf(fetchSpy.mock.calls[0]).Authorization).toMatch(/^Basic /);
  });
});

describe("testConnection through the gateway", () => {
  it("requests the spaces check on the gateway base", async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [] }) } as never);
    await testConnection(GATEWAY, "u@example.com", "tok", { gateway: true });
    expect(fetchSpy.mock.calls[0][0]).toBe(`${GATEWAY}/wiki/api/v2/spaces?limit=1`);
  });

  it.each([401, 403])("a %i names an expired, revoked or under-scoped token", async (status) => {
    fetchSpy.mockResolvedValue({ ok: false, status, statusText: "x" } as never);
    const r = await testConnection(GATEWAY, "u@example.com", "tok", { gateway: true });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/expired, revoked, or missing a scope/);
  });

  it("site mode keeps its 401 wording", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401, statusText: "x" } as never);
    const r = await testConnection("https://example.atlassian.net", "u@example.com", "tok");
    expect(r.message).toContain("invalid or expired");
  });
});

describe("probeGatewayWriteScope + classifyScopeProbe", () => {
  /** The exact body a scoped read-only token drew live (2026-11-22). */
  const LIVE_SCOPE_BODY = '{"code":401,"message":"Unauthorized; scope does not match"}';

  it("sends the dry-run PUT to the gateway base and returns the status", async () => {
    fetchSpy.mockResolvedValue({ status: 403, body: null } as never);
    expect(await probeGatewayWriteScope(GATEWAY, "u@example.com", "tok")).toEqual({
      status: 403,
      scopeMismatch: false,
    });
    expect(fetchSpy.mock.calls[0][0]).toBe(`${GATEWAY}/wiki/api/v2/pages/999999999999`);
    expect((fetchSpy.mock.calls[0][1] as { method: string }).method).toBe("PUT");
  });

  it("a transport error is undefined, not a verdict", async () => {
    fetchSpy.mockRejectedValue(new Error("offline"));
    expect(await probeGatewayWriteScope(GATEWAY, "u@example.com", "tok")).toBeUndefined();
  });

  it("the gateway's live 401 'scope does not match' answer is narrow", async () => {
    fetchSpy.mockResolvedValue(new Response(LIVE_SCOPE_BODY, { status: 401 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const probe = await probeGatewayWriteScope(GATEWAY, "u@example.com", "scoped-secret");
    expect(probe).toEqual({ status: 401, scopeMismatch: true });
    expect(classifyScopeProbe(probe)).toBe("narrow");
    // Neither the body nor the credential is logged.
    const logged = JSON.stringify([...errSpy.mock.calls, ...logSpy.mock.calls]);
    expect(logged).not.toContain("scope does not match");
    expect(logged).not.toContain("scoped-secret");
  });

  it.each([
    ['{"code":401,"message":"Unauthorized"}'],
    ['{"code":401,"message":"Token expired"}'],
    ["scope does not match"], // not JSON: only the JSON message counts
    ['{"error":"scope does not match"}'], // not the message field
    [""],
  ])("a 401 with another body (%j) stays inconclusive", async (body) => {
    fetchSpy.mockResolvedValue(new Response(body, { status: 401 }));
    const probe = await probeGatewayWriteScope(GATEWAY, "u@example.com", "tok");
    expect(probe).toEqual({ status: 401, scopeMismatch: false });
    expect(classifyScopeProbe(probe)).toBe("inconclusive");
  });

  it("matches the message case-insensitively", () => {
    expect(bodySaysScopeMismatch('{"message":"UNAUTHORIZED; Scope Does Not Match"}')).toBe(true);
    expect(bodySaysScopeMismatch("null")).toBe(false);
    expect(bodySaysScopeMismatch(undefined)).toBe(false);
  });

  it.each([
    [{ status: 403, scopeMismatch: false }, "narrow"],
    [{ status: 401, scopeMismatch: true }, "narrow"],
    [{ status: 404, scopeMismatch: false }, "broad"],
    [{ status: 400, scopeMismatch: false }, "broad"],
    [{ status: 401, scopeMismatch: false }, "inconclusive"],
    [{ status: 500, scopeMismatch: false }, "inconclusive"],
    [undefined, "inconclusive"],
  ] as const)("probe %j is %s", (probe, verdict) => {
    expect(classifyScopeProbe(probe)).toBe(verdict);
  });
});
