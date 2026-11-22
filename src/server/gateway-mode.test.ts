/**
 * Gateway mode (scoped API tokens through api.atlassian.com/ex/confluence/{cloudId}),
 * 7.6.0 (plans/next-release-sdk2-and-v2-api.md §5.3, doc/design/gateway-mode.md).
 *
 * The tenant is the thing under test: a request or credential reaching the
 * wrong tenant is the catastrophic case. Every scenario below records every
 * request the code makes and checks the invariant "a request carrying the
 * Authorization header goes to the pinned gateway prefix, nothing else".
 *
 * The OS keychain is an in-memory stub and `fetch` is stubbed: no live call is
 * ever made and no real keychain entry is read. The MCP server is a real
 * `McpServer` joined to a real `Client` by an in-memory transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  CredentialOriginRefused,
  FeatureUnavailableInGatewayMode,
  assertCredentialedUrl,
  buildApiBases,
  isCredentialedUrl,
  requestBaseFor,
  requireV1,
  resolveNextLink,
} from "./api-base.js";
import { FEATURES, TOOL_FEATURES, capabilitiesFor, toolAvailableIn, unavailableToolsFor } from "./api-capabilities.js";
import { KNOWN_TOOLS } from "./tool-allowlist.js";

vi.hoisted(() => {
  process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
  process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "0";
  process.env.EPIMETHIAN_MUTATION_LOG = "false";
  process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES = "true";
  delete process.env.CONFLUENCE_URL;
  delete process.env.CONFLUENCE_EMAIL;
  delete process.env.CONFLUENCE_API_TOKEN;
});

// ---------------------------------------------------------------------------
// Fixtures: ids are placeholders, hosts are example domains.
// ---------------------------------------------------------------------------

const SITE = "https://example.atlassian.net";
const CLOUD_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const OTHER_CLOUD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const GATEWAY = `https://api.atlassian.com/ex/confluence/${CLOUD_ID}`;
const SECRET = "scoped-secret-token";
const AUTH = "Basic " + Buffer.from(`user@example.com:${SECRET}`).toString("base64");

type Record_ = Record<string, unknown>;
const keychain = vi.hoisted(() => ({ record: null as Record<string, unknown> | null, saves: [] as unknown[] }));
const settings = vi.hoisted(() => ({ current: { posture: "read-write" } as Record<string, unknown> | undefined }));
const boot = vi.hoisted(() => ({ serverTransport: undefined as unknown }));

vi.mock("../shared/keychain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/keychain.js")>();
  return {
    ...actual,
    // Through the real parser, so a field it does not copy is lost here exactly as in production.
    readFromKeychain: vi.fn(async () => (keychain.record ? actual.parseKeychainRecord({ ...keychain.record }) : null)),
    saveToKeychain: vi.fn(async (r: unknown) => void keychain.saves.push(r)),
  };
});
vi.mock("../shared/profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/profiles.js")>();
  return { ...actual, getProfileSettings: vi.fn(async () => settings.current) };
});
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(function () {
    return boot.serverTransport;
  }),
}));
vi.mock("../shared/update-check.js", () => ({
  checkForUpdates: vi.fn().mockResolvedValue(null),
  getPendingUpdate: vi.fn().mockResolvedValue(null),
  clearPendingUpdate: vi.fn().mockResolvedValue(undefined),
  performUpgrade: vi.fn().mockResolvedValue("installed"),
}));

const gatewayRecord = (extra: Record_ = {}): Record_ => ({
  url: SITE,
  email: "user@example.com",
  apiToken: SECRET,
  cloudId: CLOUD_ID,
  tenantDisplayName: "Example",
  apiMode: "gateway",
  ...extra,
});

// ---------------------------------------------------------------------------
// Recording fetch stub
// ---------------------------------------------------------------------------

interface Req {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}
const requests: Req[] = [];
const net = { tenantCloudId: CLOUD_ID, tenantInfoOk: true, probeStatus: 403, pageVersion: 4 };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const PAGE_BODY = "<p>" + "Lorem ipsum dolor sit amet. ".repeat(20) + "</p>";
const pageView = (withBody: boolean) => ({
  id: "5001",
  title: "Runbook",
  spaceId: "1001",
  status: "current",
  version: { number: net.pageVersion },
  ...(withBody ? { body: { storage: { value: PAGE_BODY } } } : {}),
});

type Route = (url: string, method: string, body: unknown) => Response;

const defaultRoute: Route = (url, method, body) => {
  if (url === `${SITE}/_edge/tenant_info`) {
    return net.tenantInfoOk ? json({ cloudId: net.tenantCloudId, cloudName: "Example" }) : json({}, 503);
  }
  if (!url.startsWith(`${GATEWAY}/wiki/api/v2`)) return json({ message: `unexpected ${method} ${url}` }, 404);
  const p = url.slice(`${GATEWAY}/wiki/api/v2`.length).split("?")[0];
  const q = new URL(url).searchParams;

  if (p === "/spaces") return json({ results: [{ id: "1001", key: "DOCS", name: "Docs", type: "global" }] });
  if (p === "/spaces/1001") return json({ id: "1001", key: "DOCS", name: "Docs", type: "global" });
  if (p === "/pages/999999999999" && method === "PUT") return json({ message: "probe" }, net.probeStatus);
  if (p === "/pages/5001" && method === "GET") return json(pageView(q.has("body-format")));
  if (p === "/pages/5001" && method === "PUT") {
    net.pageVersion = (body as { version: { number: number } }).version.number;
    return json(pageView(false));
  }
  if (p === "/pages" && method === "GET") return json({ results: [] });
  if (p === "/pages" && method === "POST") return json({ ...pageView(false), id: "5002", version: { number: 1 } });
  return json({ message: `unexpected ${method} ${p}` }, 404);
};

let route: Route = defaultRoute;
/** Responses served before the route, in order (redirect chains, one-off failures). */
const queue: Response[] = [];
const enqueue = (...r: Response[]) => void queue.push(...r);

/** Every call is recorded first, so assertions see exactly what was attempted. */
const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  let body: unknown;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  requests.push({ url, method, authorization: headers.get("authorization") ?? undefined, body });
  const res = queue.shift() ?? route(url, method, body);
  // Like the real fetch: unless the caller asked for `redirect: "manual"`, a
  // 3xx is followed, with the same init (credential and, for 307/308, the
  // method and body). Callers that must not follow have to say so.
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location && init?.redirect !== "manual") {
    return fetchMock(new URL(location, url).toString(), init);
  }
  return res;
});

const authorisedRequests = () => requests.filter((r) => r.authorization !== undefined);
const rest = (r: Req) => r.url.includes("/wiki/rest/api/");

/** The tenant invariant, checked after every scenario. */
afterEach(() => {
  for (const r of authorisedRequests()) {
    expect(r.url.startsWith(`${GATEWAY}/`), `credential went to ${r.url}`).toBe(true);
    expect(r.url.startsWith(SITE), "credential reached the site origin").toBe(false);
  }
  // The scoped token never appears in any URL.
  for (const r of requests) expect(r.url).not.toContain(SECRET);
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class ProcessExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let errLines: string[];

beforeEach(() => {
  requests.length = 0;
  keychain.saves.length = 0;
  keychain.record = gatewayRecord();
  settings.current = { posture: "read-write" };
  Object.assign(net, { tenantCloudId: CLOUD_ID, tenantInfoOk: true, probeStatus: 403, pageVersion: 4 });
  fetchMock.mockClear();
  route = defaultRoute;
  queue.length = 0;
  errLines = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errLines.push(a.join(" ")));
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ProcessExitError(code ?? 0);
  }) as never);
  process.env.CONFLUENCE_PROFILE = "gw-test";
  delete process.env.CONFLUENCE_URL;
  delete process.env.CONFLUENCE_EMAIL;
  delete process.env.CONFLUENCE_API_TOKEN;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-12-01T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.CONFLUENCE_PROFILE;
});

async function loadClient() {
  vi.resetModules();
  return import("./confluence-client.js");
}

// ===========================================================================
// 1. Pure contracts
// ===========================================================================

describe("tool surface table", () => {
  it("TOOL_FEATURES has exactly one entry per known tool, so a new tool cannot reach gateway mode unmapped", () => {
    expect(Object.keys(TOOL_FEATURES).sort()).toEqual([...KNOWN_TOOLS].sort());
  });

  it("every feature named in the table exists", () => {
    const known = new Set<string>(FEATURES);
    for (const needs of Object.values(TOOL_FEATURES)) for (const f of needs) expect(known.has(f)).toBe(true);
  });

  it("a tool is available iff all its features are; an unmapped tool is unavailable in gateway mode", () => {
    for (const [name, needs] of Object.entries(TOOL_FEATURES)) {
      expect(toolAvailableIn("gateway", name)).toBe(needs.every((f) => capabilitiesFor("gateway")[f]));
      expect(toolAvailableIn("site", name)).toBe(true);
      expect(toolAvailableIn(undefined, name)).toBe(true);
    }
    expect(toolAvailableIn("gateway", "some_future_tool")).toBe(false);
  });

  it("tools that write over two APIs list every step's feature (no half-completed write)", () => {
    // add_drawio_diagram: v1 upload then v2 page edit. update_drawio_diagram: v1 version upload.
    expect(TOOL_FEATURES.add_drawio_diagram).toContain("attachments.upload");
    expect(TOOL_FEATURES.add_drawio_diagram).toContain("content.write");
    expect(TOOL_FEATURES.update_drawio_diagram).toContain("attachments.upload");
    expect(toolAvailableIn("gateway", "add_drawio_diagram")).toBe(false);
    expect(toolAvailableIn("gateway", "update_drawio_diagram")).toBe(false);
    expect(toolAvailableIn("gateway", "add_attachment")).toBe(false);
  });

  it("pins the unavailable list (order is table order)", () => {
    expect(unavailableToolsFor("gateway")).toEqual([
      "search_pages",
      "add_attachment",
      "add_drawio_diagram",
      "update_drawio_diagram",
      "download_attachment",
      "add_label",
      "remove_label",
      "get_page_status",
      "set_page_status",
      "remove_page_status",
      "get_recent_changes",
      "lookup_user",
      "resolve_page_link",
    ]);
    expect(unavailableToolsFor("site")).toEqual([]);
  });
});

describe("origin and prefix pinning (pure predicate)", () => {
  it("gateway: only the sealed prefix is credentialed", () => {
    const base = requestBaseFor({ url: SITE, apiMode: "gateway", sealedCloudId: CLOUD_ID });
    expect(isCredentialedUrl(`${GATEWAY}/wiki/api/v2/pages/1`, base)).toBe(true);
    // another tenant's cloudId on the same gateway origin
    expect(isCredentialedUrl(`https://api.atlassian.com/ex/confluence/${OTHER_CLOUD_ID}/wiki/api/v2/pages/1`, base)).toBe(false);
    // the gateway origin without the prefix
    expect(isCredentialedUrl("https://api.atlassian.com/wiki/api/v2/pages/1", base)).toBe(false);
    expect(isCredentialedUrl("https://api.atlassian.com/ex/confluence/", base)).toBe(false);
    // prefix without the slash boundary
    expect(isCredentialedUrl(`${GATEWAY}x/wiki/api/v2/pages/1`, base)).toBe(false);
    expect(isCredentialedUrl(GATEWAY, base)).toBe(false);
    // the site origin, and a lookalike host
    expect(isCredentialedUrl(`${SITE}/wiki/api/v2/pages/1`, base)).toBe(false);
    expect(isCredentialedUrl(`https://api.atlassian.com.evil.example/ex/confluence/${CLOUD_ID}/x`, base)).toBe(false);
    expect(isCredentialedUrl(`https://api.atlassian.com@evil.example/ex/confluence/${CLOUD_ID}/x`, base)).toBe(false);
    expect(isCredentialedUrl(`http://api.atlassian.com/ex/confluence/${CLOUD_ID}/x`, base)).toBe(false);
    expect(isCredentialedUrl(`https://u:p@api.atlassian.com/ex/confluence/${CLOUD_ID}/x`, base)).toBe(false);
  });

  it("gateway: dot segments and encoded separators cannot climb out of the prefix", () => {
    const base = GATEWAY;
    expect(isCredentialedUrl(`${GATEWAY}/../${OTHER_CLOUD_ID}/wiki`, base)).toBe(false);
    expect(isCredentialedUrl(`${GATEWAY}/%2e%2e/${OTHER_CLOUD_ID}/wiki`, base)).toBe(false);
    expect(isCredentialedUrl(`${GATEWAY}/..%2f${OTHER_CLOUD_ID}/wiki`, base)).toBe(false);
    expect(isCredentialedUrl(`${GATEWAY}/wiki/a%5cb`, base)).toBe(false);
  });

  it("gateway: `;` path parameters and `..;` segments are refused (review D3)", () => {
    const base = GATEWAY;
    expect(isCredentialedUrl(`${GATEWAY}/..;/${OTHER_CLOUD_ID}/wiki/api/v2/pages/1`, base)).toBe(false);
    expect(isCredentialedUrl(`${GATEWAY}/wiki/api/v2/pages/1;jsessionid=x`, base)).toBe(false);
    expect(isCredentialedUrl(`${GATEWAY}/wiki;x/api/v2/pages/1`, base)).toBe(false);
    expect(isCredentialedUrl(`${GATEWAY}/wiki/..%3b/api/v2/pages/1`, base)).toBe(false);
    expect(isCredentialedUrl(`${GATEWAY}/wiki/x%3By/api`, base)).toBe(false);
    // a semicolon in the query is not a path parameter
    expect(isCredentialedUrl(`${GATEWAY}/wiki/api/v2/pages?cql=a;b`, base)).toBe(true);
  });

  it("site: same origin, as before; any other origin is refused", () => {
    expect(isCredentialedUrl(`${SITE}/wiki/api/v2/pages/1`, SITE)).toBe(true);
    expect(isCredentialedUrl("https://other.atlassian.net/wiki/api/v2/pages/1", SITE)).toBe(false);
    expect(isCredentialedUrl("https://api.atlassian.com/ex/confluence/x/y", SITE)).toBe(false);
    expect(isCredentialedUrl("not a url", SITE)).toBe(false);
  });

  it("property: under a gateway base, a URL is credentialed iff it is below the sealed prefix", () => {
    const cloudIds = fc.uuid();
    fc.assert(
      fc.property(cloudIds, cloudIds, fc.constantFrom("", "/wiki/api/v2/pages/1", "/x", "/"), (sealed, other, tail) => {
        const base = `https://api.atlassian.com/ex/confluence/${sealed}`;
        const same = isCredentialedUrl(`${base}${tail === "" ? "" : tail}`, base);
        const foreign = isCredentialedUrl(`https://api.atlassian.com/ex/confluence/${other}${tail}`, base);
        return same === (tail !== "") && (foreign === (other === sealed && tail !== ""));
      }),
      { seed: 760, numRuns: 200 },
    );
  });

  it("assertCredentialedUrl throws a typed refusal that does not echo the full URL", () => {
    expect(() => assertCredentialedUrl(`${SITE}/wiki/api/v2/pages/1?secret=abc`, GATEWAY)).toThrow(CredentialOriginRefused);
    try {
      assertCredentialedUrl(`${SITE}/wiki/api/v2/pages/1?secret=abc`, GATEWAY);
    } catch (e) {
      expect((e as Error).message).not.toContain("secret=abc");
    }
  });
});

describe("pagination cursors (pure)", () => {
  it("site: unchanged: /wiki is added when missing, origin is kept", () => {
    expect(resolveNextLink("/rest/api/search?cursor=1", SITE)).toBe(`${SITE}/wiki/rest/api/search?cursor=1`);
    expect(resolveNextLink("/wiki/rest/api/search?cursor=1", SITE)).toBe(`${SITE}/wiki/rest/api/search?cursor=1`);
  });

  it("gateway: a relative cursor resolves under the sealed prefix", () => {
    expect(resolveNextLink("/wiki/api/v2/pages?cursor=abc", GATEWAY)).toBe(`${GATEWAY}/wiki/api/v2/pages?cursor=abc`);
    expect(resolveNextLink("/api/v2/pages?cursor=abc", GATEWAY)).toBe(`${GATEWAY}/wiki/api/v2/pages?cursor=abc`);
    // a cursor that already carries the sealed prefix is accepted as is
    expect(resolveNextLink(`/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages?cursor=abc`, GATEWAY)).toBe(
      `${GATEWAY}/wiki/api/v2/pages?cursor=abc`,
    );
  });

  it("gateway: a cursor naming another cloudId, or a gateway path without the prefix, is refused", () => {
    expect(resolveNextLink(`/ex/confluence/${OTHER_CLOUD_ID}/wiki/api/v2/pages?cursor=abc`, GATEWAY)).toBeNull();
    expect(resolveNextLink("/ex/jira/x/rest/api", GATEWAY)).toBeNull();
    expect(resolveNextLink(`/ex/confluence/${CLOUD_ID}x/wiki/api/v2/pages`, GATEWAY)).toBeNull();
    expect(resolveNextLink(`/ex/confluence/${CLOUD_ID}/../${OTHER_CLOUD_ID}/wiki`, GATEWAY)).toBeNull();
  });

  it.each(["https://evil.example/x", "//evil.example/x", "/wiki/a\\b", "/wiki/x://y", "wiki/x", 5, null, undefined])(
    "never follows %s in either mode",
    (next) => {
      expect(resolveNextLink(next, GATEWAY)).toBeNull();
      expect(resolveNextLink(next, SITE)).toBeNull();
    },
  );
});

// ===========================================================================
// 2. Config, v1 refusal, download pinning (real client, stubbed keychain/fetch)
// ===========================================================================

describe("gateway Config", () => {
  it("apiV1 is null, apiV2 is the sealed gateway, and the expiry is carried", async () => {
    keychain.record = gatewayRecord({ tokenExpiry: "2027-01-31" });
    const { getConfig } = await loadClient();
    const cfg = await getConfig();
    expect(cfg.apiMode).toBe("gateway");
    expect(cfg.apiV1).toBeNull();
    expect(cfg.apiV2).toBe(`${GATEWAY}/wiki/api/v2`);
    expect(cfg.sealedCloudId).toBe(CLOUD_ID);
    expect(cfg.tokenExpiry).toBe("2027-01-31");
    expect(cfg.url).toBe(SITE);
    expect(requestBaseFor(cfg)).toBe(GATEWAY);
  });

  it("a record without apiMode is site mode, byte-identical bases", async () => {
    keychain.record = { url: SITE, email: "user@example.com", apiToken: SECRET, cloudId: CLOUD_ID };
    const { getConfig } = await loadClient();
    const cfg = await getConfig();
    expect(cfg.apiMode).toBe("site");
    expect(cfg.apiV2).toBe(`${SITE}/wiki/api/v2`);
    expect(cfg.apiV1).toBe(`${SITE}/wiki/rest/api`);
    expect(cfg.tokenExpiry).toBeUndefined();
  });

  it("refuses to start for a gateway record without a sealed cloudId, naming setup", async () => {
    keychain.record = gatewayRecord({ cloudId: undefined });
    delete keychain.record!.cloudId;
    const { getConfig } = await loadClient();
    await expect(getConfig()).rejects.toThrow(ProcessExitError);
    expect(errLines.join("\n")).toMatch(/gateway mode.*no tenant seal/s);
    expect(errLines.join("\n")).toContain("epimethian-mcp setup --profile gw-test");
    expect(requests).toEqual([]);
  });

  it("refuses a malformed seal rather than building a URL from it", async () => {
    keychain.record = gatewayRecord({ cloudId: "../other-tenant" });
    const { getConfig } = await loadClient();
    await expect(getConfig()).rejects.toThrow(ProcessExitError);
    expect(requests).toEqual([]);
  });

  it("env-var mode is always site mode", async () => {
    delete process.env.CONFLUENCE_PROFILE;
    process.env.CONFLUENCE_URL = SITE;
    process.env.CONFLUENCE_EMAIL = "user@example.com";
    process.env.CONFLUENCE_API_TOKEN = SECRET;
    const { getConfig } = await loadClient();
    expect((await getConfig()).apiMode).toBe("site");
    delete process.env.CONFLUENCE_URL;
    delete process.env.CONFLUENCE_EMAIL;
  });
});

describe("v1 helpers in gateway mode throw before any request", () => {
  // Reads owned by the v2-read lane are excluded: they move to v2 and are tested there.
  it.each([
    ["addLabels", (c: any) => c.addLabels("5001", ["x"])],
    ["removeLabel", (c: any) => c.removeLabel("5001", "x")],
    ["getContentState", (c: any) => c.getContentState("5001")],
    ["setContentState", (c: any) => c.setContentState("5001", "AI-edited", "#FFC400")],
    ["removeContentState", (c: any) => c.removeContentState("5001")],
    ["searchContent", (c: any) => c.searchContent('type=page', { limit: 5, expandVersion: false })],
    ["searchPagesByTitle", (c: any) => c.searchPagesByTitle("t", "DOCS")],
    ["searchUsers", (c: any) => c.searchUsers("alice")],
    ["uploadAttachment", (c: any) => c.uploadAttachment("5001", Buffer.from("x"), "f.txt")],
    ["uploadAttachmentVersion", (c: any) => c.uploadAttachmentVersion("5001", "att1", Buffer.from("x"), "f.txt")],
  ])("%s", async (_name, call) => {
    const client = await loadClient();
    // The client module is re-imported per test, so match on the error's identity fields, not its class.
    await expect(call(client)).rejects.toMatchObject({ name: "FeatureUnavailableInGatewayMode" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ensureAttributionLabel and markPageUnverified are skipped silently: {} and no request", async () => {
    const client = await loadClient();
    const { markPageUnverified } = await import("./provenance.js");
    expect(await client.ensureAttributionLabel("5001")).toEqual({});
    expect(await markPageUnverified("5001", await client.getConfig())).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the same calls in site mode still reach the v1 API (the skip is gateway-only)", async () => {
    keychain.record = { url: SITE, email: "user@example.com", apiToken: SECRET, cloudId: CLOUD_ID };
    const client = await loadClient();
    route = () => json({ results: [] });
    await client.ensureAttributionLabel("5001").catch(() => {});
    expect(requests.some(rest)).toBe(true);
    // Site mode stays on the site origin: the label read is v2 (7.6.0 read swap), the label write v1.
    expect(requests.every((r) => r.url.startsWith(`${SITE}/wiki/`))).toBe(true);
    // Site mode sends credentials to the site origin by design; this test opts out of the gateway invariant.
    requests.length = 0;
  });
});

describe("download pinning in gateway mode", () => {
  const meta = (downloadLink: string) => ({ id: "att1", title: "f.png", pageId: "5001", downloadLink }) as never;

  async function download(link: string) {
    const client = await loadClient();
    return client.downloadAttachmentBytes(meta(link));
  }

  it.each([
    [`https://api.atlassian.com/ex/confluence/${OTHER_CLOUD_ID}/wiki/download/attachments/5001/f.png`, "another cloudId"],
    ["https://api.atlassian.com/wiki/download/attachments/5001/f.png", "the gateway origin without the prefix"],
    [`${GATEWAY}x/wiki/download/attachments/5001/f.png`, "the prefix without the slash boundary"],
    [`${SITE}/wiki/download/attachments/5001/f.png`, "the site origin"],
    ["https://media.example.net/f.png", "a third-party host"],
  ])("refuses an absolute link to %s (%s) without sending anything", async (link) => {
    await expect(download(link)).rejects.toThrow(/Refusing to download/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a relative link that climbs out of the prefix", async () => {
    await expect(download(`/wiki/../../${OTHER_CLOUD_ID}/wiki/download/x`)).rejects.toThrow(/Refusing to download/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a relative link is fetched under the sealed prefix with the credential", async () => {
    enqueue(new Response("bytes", { status: 200 }));
    const bytes = await download("/download/attachments/5001/f.png");
    expect(bytes.toString()).toBe("bytes");
    expect(requests[0].url).toBe(`${GATEWAY}/wiki/download/attachments/5001/f.png`);
    expect(requests[0].authorization).toBe(AUTH);
  });

  it("a redirect off the prefix (site origin, another cloudId, or a media host) is followed without the credential", async () => {
    for (const target of [
      `${SITE}/wiki/download/signed`,
      `https://api.atlassian.com/ex/confluence/${OTHER_CLOUD_ID}/wiki/download/signed`,
      "https://media.example.net/signed?token=t",
    ]) {
      requests.length = 0;
      enqueue(
        new Response(null, { status: 302, headers: { location: target } }),
        new Response("bytes", { status: 200 }),
      );
      await download("/download/attachments/5001/f.png");
      expect(requests).toHaveLength(2);
      expect(requests[0].authorization).toBe(AUTH);
      expect(requests[1].url).toBe(target);
      expect(requests[1].authorization, `credential forwarded to ${target}`).toBeUndefined();
    }
  });

  it("a redirect that comes back under the prefix after leaving it stays uncredentialed (latch)", async () => {
    enqueue(
      new Response(null, { status: 302, headers: { location: "https://media.example.net/hop" } }),
      new Response(null, { status: 302, headers: { location: `${GATEWAY}/wiki/download/back` } }),
      new Response("bytes", { status: 200 }),
    );
    await download("/download/attachments/5001/f.png");
    expect(requests.map((r) => r.authorization !== undefined)).toEqual([true, false, false]);
  });
});

// ===========================================================================
// Redirects on credentialed requests (review D1)
// ===========================================================================

describe("credentialed requests never follow a redirect in gateway mode", () => {
  const elsewhere = `https://api.atlassian.com/ex/confluence/${OTHER_CLOUD_ID}/wiki/api/v2/pages/5001`;

  it("a read answered 307 to another cloudId's prefix: an error, and no second credentialed request", async () => {
    const client = await loadClient();
    enqueue(new Response(null, { status: 307, headers: { location: elsewhere } }));
    await expect(client.getPage("5001", false)).rejects.toThrow(/redirect/i);
    expect(requests).toHaveLength(1);
    expect(requests.some((r) => r.url.includes(OTHER_CLOUD_ID))).toBe(false);
  });

  it("a write answered 307 is not replayed: outcome unknown, one request", async () => {
    const client = await loadClient();
    enqueue(new Response(null, { status: 307, headers: { location: elsewhere } }));
    await expect(client.deletePage("5001")).rejects.toMatchObject({ name: "WriteOutcomeUnknownError" });
    expect(requests).toHaveLength(1);
    expect(requests.some((r) => r.url.includes(OTHER_CLOUD_ID))).toBe(false);
  });

  it("even a redirect that stays under the sealed prefix is not followed", async () => {
    const client = await loadClient();
    enqueue(new Response(null, { status: 302, headers: { location: `${GATEWAY}/wiki/api/v2/pages/5001` } }));
    await expect(client.getPage("5001", false)).rejects.toThrow(/redirect/i);
    expect(requests).toHaveLength(1);
  });

  it("site mode is unchanged: a same-site redirect is followed", async () => {
    keychain.record = { url: SITE, email: "user@example.com", apiToken: SECRET, cloudId: CLOUD_ID };
    const client = await loadClient();
    enqueue(
      new Response(null, { status: 302, headers: { location: `${SITE}/wiki/api/v2/pages/5001?moved=1` } }),
      json({ id: "5001", title: "Runbook", spaceId: "1001", version: { number: 4 } }),
    );
    const page = await client.getPage("5001", false);
    expect(page.title).toBe("Runbook");
    expect(requests).toHaveLength(2);
    // Site mode sends credentials to the site origin by design; opt out of the gateway invariant.
    requests.length = 0;
  });
});

// ===========================================================================
// 3. Startup
// ===========================================================================

describe("validateStartup in gateway mode", () => {
  async function start(): Promise<void> {
    const { getConfig, validateStartup } = await loadClient();
    await validateStartup(await getConfig());
  }

  it("a site whose tenant_info returns a different cloudId refuses to start, before any credentialed call", async () => {
    net.tenantCloudId = OTHER_CLOUD_ID;
    await expect(start()).rejects.toThrow(ProcessExitError);
    expect(errLines.join("\n")).toContain("Tenant seal mismatch");
    expect(requests.map((r) => r.url)).toEqual([`${SITE}/_edge/tenant_info`]);
    expect(authorisedRequests()).toEqual([]);
  });

  it("an unreachable tenant_info refuses to start (fail closed), without any credentialed call", async () => {
    net.tenantInfoOk = false;
    await expect(start()).rejects.toThrow(ProcessExitError);
    expect(errLines.join("\n")).toContain("Tenant seal cannot be verified");
    expect(authorisedRequests()).toEqual([]);
  });

  it("success: unauthenticated tenant_info on the site, then spaces through the gateway; no v1, no identity check", async () => {
    await start();
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${SITE}/_edge/tenant_info`,
      `GET ${GATEWAY}/wiki/api/v2/spaces?limit=1`,
    ]);
    expect(requests[0].authorization).toBeUndefined();
    expect(requests[1].authorization).toBe(AUTH);
    expect(requests.some(rest)).toBe(false);
    expect(errLines.join("\n")).toContain("via the Atlassian API gateway");
    expect(errLines.join("\n")).toMatch(/email identity check is skipped/);
    expect(keychain.saves).toEqual([]); // the opportunistic seal re-save is unreachable in gateway mode
  });

  it("a 401 from the gateway names an expired, revoked or under-scoped token", async () => {
    enqueue(json({ cloudId: CLOUD_ID }), json({ message: "no" }, 401));
    await expect(start()).rejects.toThrow(ProcessExitError);
    expect(errLines.join("\n")).toMatch(/expired, revoked, or missing a scope/);
  });

  it("posture 'detect' probes the dry-run write through the gateway only (the v1 permission probe degrades)", async () => {
    settings.current = { posture: "detect" };
    net.probeStatus = 403;
    await start();
    const puts = requests.filter((r) => r.method === "PUT");
    expect(puts.map((r) => r.url)).toEqual([`${GATEWAY}/wiki/api/v2/pages/999999999999`]);
    expect(requests.some(rest)).toBe(false);
  });

  it.each([410, 429])("posture 'detect': a dry-run answered %i is inconclusive and resolves to read-only, with a note", async (status) => {
    settings.current = { posture: "detect" };
    net.probeStatus = status;
    const { getConfig, validateStartup, _resetHttpStateForTests } = await loadClient();
    _resetHttpStateForTests({ sleep: async () => {} });
    await validateStartup(await getConfig());
    const cfg = await getConfig();
    expect(cfg.probedCapability).toBe("inconclusive");
    expect(cfg.effectivePosture).toBe("read-only");
    expect(errLines.join("\n")).toMatch(/inconclusive.*read-only/);
  });

  it("the opportunistic seal re-save of a pre-seal profile keeps a recorded tokenExpiry (site mode)", async () => {
    // A record without a seal: startup seals it with `{ ...stored, cloudId }`.
    keychain.record = { url: SITE, email: "user@example.com", apiToken: SECRET, tokenExpiry: "2027-01-31" };
    route = (url) => {
      if (url === `${SITE}/_edge/tenant_info`) return json({ cloudId: CLOUD_ID, cloudName: "Example" });
      if (url.endsWith("/wiki/rest/api/user/current")) return json({ email: "user@example.com" });
      return json({ results: [] });
    };
    await start();
    expect(keychain.saves).toEqual([
      expect.objectContaining({ cloudId: CLOUD_ID, tokenExpiry: "2027-01-31", apiToken: SECRET }),
    ]);
    requests.length = 0; // site mode credentials the site origin by design
  });

  describe("token expiry (frozen clock 2026-12-01)", () => {
    it("expired: clear startup error naming the date and setup, before any request", async () => {
      keychain.record = gatewayRecord({ tokenExpiry: "2026-11-30" });
      await expect(start()).rejects.toThrow(ProcessExitError);
      expect(errLines.join("\n")).toContain("expired on 2026-11-30");
      expect(errLines.join("\n")).toContain("epimethian-mcp setup --profile gw-test");
      expect(requests).toEqual([]);
    });

    it.each([
      ["2026-12-01", "today"],
      ["2026-12-15", "in 14 days"],
    ])("expiry %s warns on the stderr banner (%s) and starts", async (expiry, when) => {
      keychain.record = gatewayRecord({ tokenExpiry: expiry });
      await start();
      expect(errLines.join("\n")).toContain(`expires ${when}`);
    });

    it("15 days left: no warning", async () => {
      keychain.record = gatewayRecord({ tokenExpiry: "2026-12-16" });
      await start();
      expect(errLines.join("\n")).not.toMatch(/token for profile .* expires/);
    });

    it("no expiry recorded: no warning, starts", async () => {
      await start();
      expect(errLines.join("\n")).not.toMatch(/token for profile .* expires/);
    });
  });
});

// ===========================================================================
// 4. Server: tools/list, instructions, writes
// ===========================================================================

interface Booted {
  readonly tools: readonly { name: string }[];
  readonly instructions: string | undefined;
  readonly list: () => Promise<string>;
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text?: string }[] }>;
}

async function bootServer(): Promise<Booted> {
  vi.resetModules();
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  boot.serverTransport = serverTransport;
  const { main } = await import("./index.js");
  await main();
  const client = new Client({ name: "gateway-test", version: "1.0.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  return {
    tools,
    instructions: client.getInstructions(),
    list: async () => JSON.stringify((await client.listTools()).tools),
    callTool: (name, args) => client.callTool({ name, arguments: args }) as never,
  };
}

/** Registration order of the 28 tools a read-write gateway profile sees. */
const GOLDEN_GATEWAY_TOOLS = [
  "create_page",
  "get_page",
  "authorise_destructive_writes",
  "update_page",
  "create_blog_post",
  "update_blog_post",
  "delete_page",
  "update_page_section",
  "update_page_sections",
  "prepend_to_page",
  "append_to_page",
  "list_pages",
  "get_page_children",
  "get_spaces",
  "check_permissions",
  "get_page_by_title",
  "get_attachments",
  "get_labels",
  "get_comments",
  "create_comment",
  "resolve_comment",
  "delete_comment",
  "get_page_versions",
  "get_page_version",
  "diff_page_versions",
  "revert_page",
  "get_version",
  "upgrade",
];

describe("tools/list in gateway mode", () => {
  it("equals the golden list, hides every v1-only tool, and is byte-identical across two calls", async () => {
    const s = await bootServer();
    expect(s.tools.map((t) => t.name)).toEqual(GOLDEN_GATEWAY_TOOLS);

    const first = await s.list();
    const second = await s.list();
    expect(second).toBe(first);

    const hidden = unavailableToolsFor("gateway");
    for (const name of hidden) expect(s.tools.map((t) => t.name)).not.toContain(name);
    // Registered + hidden = every known tool: nothing is lost or invented.
    expect([...GOLDEN_GATEWAY_TOOLS, ...hidden].sort()).toEqual([...KNOWN_TOOLS].sort());
  });

  it("is stable across two server boots of the same profile", async () => {
    const a = await (await bootServer()).list();
    const b = await (await bootServer()).list();
    expect(b).toBe(a);
  });

  it("read-only posture registers only the read tools of the gateway set, and no write tool", async () => {
    settings.current = { posture: "read-only" };
    const s = await bootServer();
    const names = s.tools.map((t) => t.name);
    for (const w of ["create_page", "update_page", "delete_page", "create_comment", "revert_page"]) {
      expect(names).not.toContain(w);
    }
    expect(names).toContain("get_page");
    expect(names).toContain("get_page_versions");
  });

  it("the instructions name the mode and every missing tool, and are stable", async () => {
    const s = await bootServer();
    expect(s.instructions).toContain("Gateway mode (scoped API token): these tools are unavailable:");
    for (const name of unavailableToolsFor("gateway")) expect(s.instructions).toContain(name);
    // The start-here line does not send the agent to a tool that is not registered.
    expect(s.instructions).not.toContain("Start with search_pages");
    expect(s.instructions!.length).toBeLessThan(4096);
  });

  it("site mode: all 41 tools, and no gateway line", async () => {
    keychain.record = { url: SITE, email: "user@example.com", apiToken: SECRET, cloudId: CLOUD_ID };
    // Site startup talks to the site origin by design; serve it.
    route = (url) => {
      if (url.endsWith("/_edge/tenant_info")) return json({ cloudId: CLOUD_ID, cloudName: "Example" });
      if (url.endsWith("/wiki/rest/api/user/current")) return json({ email: "user@example.com" });
      return json({ results: [] });
    };
    const s = await bootServer();
    expect(s.tools).toHaveLength(KNOWN_TOOLS.length);
    expect(s.instructions).not.toContain("Gateway mode");
    expect(s.instructions).toContain("Start with search_pages");
    requests.length = 0; // site mode is allowed to credential the site origin
  });
});

describe("writes in gateway mode", () => {
  it("update_page: no v1 request, the PUT carries the Epimethian version comment, and every credential goes to the gateway", async () => {
    const s = await bootServer();
    requests.length = 0;
    const r = await s.callTool("update_page", {
      page_id: "5001",
      title: "Runbook",
      version: 4,
      body: PAGE_BODY.replace("Lorem", "Edited lorem"),
    });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();

    expect(requests.some(rest)).toBe(false);
    const puts = requests.filter((q) => q.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe(`${GATEWAY}/wiki/api/v2/pages/5001`);
    const message = (puts[0].body as { version: { message: string } }).version.message;
    expect(message).toMatch(/Epimethian v/);
    expect(message).toContain("https://github.com/de-otio/epimethian-mcp");
    // Silent skip: no per-write warning for the label or the badge reaches the agent.
    const text = r.content.map((c) => c.text ?? "").join("\n");
    expect(text).not.toMatch(/label|badge|AI-edited|epimethian-edited/i);
  });

  it("create_page: no v1 request, the POST carries the version comment, no warning", async () => {
    const s = await bootServer();
    requests.length = 0;
    const r = await s.callTool("create_page", { space_key: "DOCS", title: "New", body: "<p>hello</p>" });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(requests.some(rest)).toBe(false);
    const post = requests.find((q) => q.method === "POST");
    expect(post?.url).toBe(`${GATEWAY}/wiki/api/v2/pages`);
    expect((post!.body as { version: { message: string } }).version.message).toMatch(/Epimethian v/);
    expect(r.content.map((c) => c.text ?? "").join("\n")).not.toMatch(/label|badge|AI-edited/i);
  });

  it("a tool that needs v1 is not callable at all: add_label, add_attachment, add_drawio_diagram never run", async () => {
    const s = await bootServer();
    requests.length = 0;
    const args: Record<string, Record<string, unknown>> = {
      add_label: { page_id: "5001", labels: ["x"] },
      add_attachment: { page_id: "5001", file_path: "/tmp/does-not-matter.png" },
      add_drawio_diagram: { page_id: "5001", diagram_name: "d", diagram_xml: "<mxGraphModel/>" },
      update_drawio_diagram: { page_id: "5001", diagram_name: "d", diagram_xml: "<mxGraphModel/>" },
      set_page_status: { page_id: "5001", name: "x", color: "#FFC400" },
    };
    for (const [name, a] of Object.entries(args)) {
      // The SDK answers an unregistered tool with "not found" (as a rejection or an error result);
      // a registered tool would answer with its own validation or FeatureUnavailable text instead.
      const text = await s.callTool(name, a).then(
        (r) => r.content.map((c) => c.text ?? "").join("\n"),
        (e: Error) => e.message,
      );
      expect(text, `${name} must not be registered`).toMatch(/not found/i);
    }
    expect(requests).toEqual([]);
  });

  it("human links in tool output come from the site URL, never from a response's _links.base", async () => {
    const client = await loadClient();
    const cfg = await client.getConfig();
    const text = await client.formatPage(
      { id: "5001", title: "Runbook", _links: { base: "https://evil.example/wiki", webui: "/spaces/DOCS/pages/5001" } },
      false,
    );
    expect(text).toContain(`${cfg.url}/wiki/spaces/DOCS/pages/5001`);
    expect(text).not.toContain("evil.example");
  });
});

describe("requireV1 / buildApiBases stay consistent with Config", () => {
  it("the bases the client uses are the ones api-base derives from the sealed id alone", async () => {
    const { getConfig } = await loadClient();
    const cfg = await getConfig();
    expect(cfg).toMatchObject(buildApiBases({ url: "https://another-host.example", apiMode: "gateway", sealedCloudId: CLOUD_ID }));
    expect(() => requireV1(cfg, "labels.write")).toThrow(FeatureUnavailableInGatewayMode);
  });
});
