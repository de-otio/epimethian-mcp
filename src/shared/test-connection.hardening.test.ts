/**
 * Gateway hardening of the shared connection helpers (7.6.0 review, D1/D2):
 *   - credentialed gateway requests never follow a redirect;
 *   - every startup/setup request has a bounded timeout.
 *
 * `fetch` is a stub that behaves like the real one on redirects: unless the
 * caller asks for `redirect: "manual"`, a 3xx with a Location is followed and
 * the Authorization header is kept for a same-origin hop (as undici does).
 * No live call is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTION_CHECK_TIMEOUT_MS,
  fetchTenantInfo,
  probeGatewayWriteScope,
  testConnection,
} from "./test-connection.js";
import { classifyScopeProbe } from "./gateway-scopes.js";

const CLOUD_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const OTHER_CLOUD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const GATEWAY = `https://api.atlassian.com/ex/confluence/${CLOUD_ID}`;
const OTHER = `https://api.atlassian.com/ex/confluence/${OTHER_CLOUD_ID}`;

interface Sent {
  url: string;
  method: string;
  authorization: string | undefined;
  redirect: RequestRedirect | undefined;
}
let sent: Sent[];

/** First answer for the first URL; anything else answers 200 `{ results: [] }`. */
function redirectingFetch(first: Response) {
  let served = false;
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    sent.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      authorization: headers.get("authorization") ?? undefined,
      redirect: init?.redirect,
    });
    const res = served ? Response.json({ results: [] }) : first;
    served = true;
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location && init?.redirect !== "manual") {
      // Default fetch behaviour: follow, keeping the credential on the same origin.
      return impl(location, init);
    }
    return res;
  };
  return impl;
}

beforeEach(() => {
  sent = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("D1: no automatic redirects on credentialed gateway requests", () => {
  it("testConnection (gateway): a 307 to another cloudId's prefix is an error, with no second request", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      redirectingFetch(new Response(null, { status: 307, headers: { location: `${OTHER}/wiki/api/v2/spaces?limit=1` } })) as never
    );
    const r = await testConnection(GATEWAY, "u@example.com", "tok", { gateway: true });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/redirect/i);
    expect(sent).toHaveLength(1);
    expect(sent[0].redirect).toBe("manual");
    expect(sent.some((s) => s.url.startsWith(OTHER))).toBe(false);
  });

  it("probeGatewayWriteScope: a 307 is not followed (the PUT is not replayed) and proves nothing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      redirectingFetch(new Response(null, { status: 307, headers: { location: `${OTHER}/wiki/api/v2/pages/999999999999` } })) as never
    );
    const status = await probeGatewayWriteScope(GATEWAY, "u@example.com", "tok");
    expect(sent).toHaveLength(1);
    expect(sent[0].redirect).toBe("manual");
    expect(classifyScopeProbe(status)).toBe("inconclusive");
  });

  it("site mode testConnection keeps the default redirect behaviour", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      redirectingFetch(
        new Response(null, { status: 302, headers: { location: "https://example.atlassian.net/wiki/api/v2/spaces?limit=1&x=1" } })
      ) as never
    );
    const r = await testConnection("https://example.atlassian.net", "u@example.com", "tok");
    expect(r.ok).toBe(true);
    expect(sent[0].redirect).toBeUndefined();
  });
});

describe("D2: bounded timeouts", () => {
  /** A fetch that never answers, but honours its abort signal like the real one. */
  const hangingFetch = async (_input: unknown, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  /** A fetch that ignores the signal entirely: the helper must still give up. */
  const deafFetch = async (): Promise<Response> => new Promise(() => {});

  it("is one named constant of 15 s", () => {
    expect(CONNECTION_CHECK_TIMEOUT_MS).toBe(15_000);
  });

  it.each([
    ["fetchTenantInfo", () => fetchTenantInfo("https://example.atlassian.net", "u", "t", { authenticated: false })],
    ["testConnection", () => testConnection(GATEWAY, "u", "t", { gateway: true })],
    ["probeGatewayWriteScope", () => probeGatewayWriteScope(GATEWAY, "u", "t")],
  ])("%s gives up after the timeout (signal honoured)", async (_name, run) => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch as never);
    let settled = false;
    const p = run().finally(() => void (settled = true));
    await vi.advanceTimersByTimeAsync(CONNECTION_CHECK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
    const r = await p;
    if (typeof r === "object" && r !== null) expect((r as { ok: boolean }).ok).toBe(false);
    else expect(r).toBeUndefined();
  });

  it.each([
    ["fetchTenantInfo", () => fetchTenantInfo("https://example.atlassian.net", "u", "t", { authenticated: false })],
    ["testConnection", () => testConnection(GATEWAY, "u", "t", { gateway: true })],
    ["probeGatewayWriteScope", () => probeGatewayWriteScope(GATEWAY, "u", "t")],
  ])("%s gives up even when fetch ignores the abort signal", async (_name, run) => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(deafFetch as never);
    let settled = false;
    const p = run().finally(() => void (settled = true));
    await vi.advanceTimersByTimeAsync(CONNECTION_CHECK_TIMEOUT_MS + 1);
    expect(settled).toBe(true);
    await p;
  });

  it("testConnection reports the timeout in its message", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(deafFetch as never);
    const p = testConnection(GATEWAY, "u", "t", { gateway: true });
    await vi.advanceTimersByTimeAsync(CONNECTION_CHECK_TIMEOUT_MS + 1);
    expect((await p).message).toMatch(/timed out after 15 s/);
  });
});
