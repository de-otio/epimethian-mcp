// Offline tests for the live parity probe. fetch is always a stub: no network,
// no keychain, no real credentials.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  INVENTORY,
  ReadOnlyViolation,
  RequestCapExceeded,
  REQUEST_CAP,
  VERSION_CAP,
  allocateVersions,
  compareBodies,
  createRecorder,
  createRequester,
  parseCliArgs,
  planRequests,
  renderReport,
  runProbe,
  selectVersionSamples,
  sha256Hex,
  UsageError,
} from "./v2-parity-lib.mjs";

const SITE = "https://tenant.example.test";
const GATEWAY = "https://api.atlassian.com/ex/confluence/00000000-0000-0000-0000-000000000000";
const AUTH = "Basic dGVzdDp0ZXN0";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A fake Confluence. One canonical model per content id, rendered in the v1
 * and v2 shapes. `opts` bends it: v1Gone (410 on every v1 path), echoOffBy
 * (v2 echoes N+1 for the given version), mutateV2Body (v2 body gets an extra
 * byte for the given version).
 */
function makeStub(model, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers ?? {} });
    const u = new URL(String(url));
    const path = u.pathname;
    const p = path.replace(/^\/ex\/confluence\/[^/]+/, "");

    if (p.startsWith("/wiki/rest/api")) {
      if (opts.v1Gone) return json({ message: "gone" }, 410);
      const rest = p.slice("/wiki/rest/api".length);
      let m;
      if ((m = rest.match(/^\/content\/(\d+)\/child\/attachment\/([^/]+)\/data$/))) {
        return new Response(null, { status: 302, headers: { location: "https://media.example.test/file/abc?token=zzz" } });
      }
      if ((m = rest.match(/^\/content\/(\d+)\/child\/attachment$/))) {
        const c = model.content[m[1]];
        return json({ results: c.attachments.map((a) => ({ id: a.id, title: a.title, version: { number: 1 }, extensions: { fileSize: a.size, mediaType: a.mediaType } })) });
      }
      if ((m = rest.match(/^\/content\/(\d+)\/version$/))) {
        const c = model.content[m[1]];
        return json({ results: c.versions.map((v) => ({ number: v.n, by: { displayName: v.author, accountId: v.accountId }, when: v.when, message: v.message, minorEdit: false })) });
      }
      if ((m = rest.match(/^\/content\/(\d+)\/label$/))) {
        const c = model.content[m[1]];
        return json({ results: c.labels.map((l, i) => ({ id: String(i + 1), prefix: "global", name: l })) });
      }
      if ((m = rest.match(/^\/content\/(\d+)\/state$/))) return json({ contentState: null });
      if ((m = rest.match(/^\/content\/(\d+)$/))) {
        const n = Number(u.searchParams.get("version"));
        const c = model.content[m[1]];
        return json({ id: m[1], title: c.title, version: { number: n }, body: { storage: { value: c.body(n) } } });
      }
      if (rest === "/user/current") return json({ displayName: model.userName, email: model.email });
      if (rest.startsWith("/user/current/permission/space/")) return json({ havePermission: true });
      if (rest === "/settings/systemInfo") return json({ defaultLocale: "en_GB" });
      if (rest === "/search") return json({ results: [] });
      if (rest === "/search/user") return json({ results: [] });
      return json({}, 404);
    }

    if (p.startsWith("/wiki/api/v2")) {
      const rest = p.slice("/wiki/api/v2".length);
      let m;
      if (rest === "/spaces") return json({ results: [{ id: "4242", key: model.spaceKey, name: model.spaceName }] });
      if ((m = rest.match(/^\/spaces\/(\d+)\/operations$/))) return json({ operations: [{ operation: "create", targetType: "page" }] });
      if ((m = rest.match(/^\/(pages|blogposts)\/(\d+)\/attachments$/))) {
        const c = model.content[m[2]];
        return json({ results: c.attachments.map((a) => ({ id: a.id, title: a.title, version: { number: 1 }, fileSize: a.size, mediaType: a.mediaType, downloadLink: `/download/attachments/${m[2]}/f` })) });
      }
      if ((m = rest.match(/^\/(pages|blogposts)\/(\d+)\/versions$/))) {
        const c = model.content[m[2]];
        return json({ results: c.versions.map((v) => ({ number: v.n, authorId: v.accountId, createdAt: v.when, message: v.message, minorEdit: false })) });
      }
      if ((m = rest.match(/^\/(pages|blogposts)\/(\d+)\/labels$/))) {
        const c = model.content[m[2]];
        return json({ results: c.labels.map((l, i) => ({ id: String(i + 1), prefix: "global", name: l })) });
      }
      if ((m = rest.match(/^\/(pages|blogposts)\/(\d+)$/))) {
        const n = Number(u.searchParams.get("version"));
        const c = model.content[m[2]];
        let body = c.body(n);
        if (opts.mutateV2Body === n) body += "!";
        const echoed = opts.echoOffBy === n ? n + 1 : n;
        return json({ id: m[2], title: c.title, version: { number: echoed }, body: { storage: { value: body } } });
      }
      return json({}, 404);
    }

    if (p.startsWith("/wiki/download/attachments/")) {
      return new Response(Buffer.from("file-bytes"), { status: 200 });
    }
    if (u.origin === "https://media.example.test") return new Response(Buffer.from("file-bytes"), { status: 200 });
    return json({}, 404);
  };
  return { fetchImpl, calls };
}

function content(overrides = {}) {
  return {
    title: "Some Title",
    attachments: [{ id: "att1", title: "file.png", size: 1000, mediaType: "image/png" }],
    versions: [8, 7, 6, 5, 4, 3, 2, 1].map((n) => ({ n, author: "Some Author", accountId: `acc-${n % 2}`, when: `2026-01-0${n}T10:00:00.000Z`, message: `msg ${n}` })),
    labels: ["alpha", "beta"],
    body: (n) => `<p>version ${n}</p>`,
    ...overrides,
  };
}

function baseModel(contentById = { 11: content(), 12: content(), 21: content() }) {
  return { content: contentById, spaceKey: "SPK", spaceName: "Space Name", userName: "User Name", email: "user@example.test", };
}

const requesterFor = (stub, extra = {}) =>
  createRequester({ fetchImpl: stub.fetchImpl, authorization: AUTH, credentialedPrefixes: [`${SITE}/`, `${GATEWAY}/`], ...extra });

async function runWith(model, { mode = "site", pages = ["11", "12"], blogposts = ["21"], versionsPerId = 6, stubOpts = {} } = {}) {
  const stub = makeStub(model, stubOpts);
  const requester = requesterFor(stub);
  const recorder = await runProbe({
    request: requester.request,
    mode,
    origin: mode === "gateway" ? GATEWAY : SITE,
    pages,
    blogposts,
    versionsPerId,
  });
  const report = renderReport(recorder, { mode, date: "2026-11-22", requests: requester.count(), cap: REQUEST_CAP, scopes: [] });
  return { stub, requester, recorder, report };
}

describe("request helper: GET and HEAD only", () => {
  it("refuses write methods before counting or calling fetch", async () => {
    const stub = makeStub(baseModel());
    const r = requesterFor(stub);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "post", "OPTIONS", "", undefined]) {
      await expect(r.request(method, `${SITE}/wiki/api/v2/spaces`)).rejects.toBeInstanceOf(ReadOnlyViolation);
    }
    expect(stub.calls).toHaveLength(0);
    expect(r.count()).toBe(0);
  });

  it("refuses any method other than GET or HEAD (property)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (method) => {
        fc.pre(!["GET", "HEAD"].includes(method.toUpperCase()));
        const stub = makeStub(baseModel());
        const r = requesterFor(stub);
        await expect(r.request(method, `${SITE}/x`)).rejects.toBeInstanceOf(ReadOnlyViolation);
        expect(stub.calls).toHaveLength(0);
      }),
      { seed: 760, numRuns: 100 }
    );
  });

  it("allows GET and HEAD, and a whole probe run sends only GETs", async () => {
    const { stub } = await runWith(baseModel());
    expect(stub.calls.length).toBeGreaterThan(20);
    expect(new Set(stub.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
    const stub2 = makeStub(baseModel());
    const res = await requesterFor(stub2).request("HEAD", `${SITE}/wiki/api/v2/spaces`);
    expect(res.status).toBe(200);
  });

  it("sends the credential only under a credentialed prefix, including across redirects", async () => {
    const stub = makeStub(baseModel());
    const r = requesterFor(stub);
    const res = await r.request("GET", `${SITE}/wiki/rest/api/content/11/child/attachment/att1/data`, { wantBytes: true });
    expect(res.status).toBe(200);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0].headers.Authorization).toBe(AUTH);
    expect(stub.calls[1].url.startsWith("https://media.example.test/")).toBe(true);
    expect(stub.calls[1].headers.Authorization).toBeUndefined();
  });

  it("reports a network failure as status 0 without echoing the error", async () => {
    const r = createRequester({
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND secret-host.example.test");
      },
      authorization: AUTH,
      credentialedPrefixes: [`${SITE}/`],
    });
    expect(await r.request("GET", `${SITE}/x`)).toEqual({ status: 0 });
  });
});

describe("request cap", () => {
  it("throws on the request after the cap and never calls fetch for it", async () => {
    const stub = makeStub(baseModel());
    const r = requesterFor(stub, { maxRequests: 3 });
    for (let i = 0; i < 3; i += 1) await r.request("GET", `${SITE}/wiki/api/v2/spaces`);
    await expect(r.request("GET", `${SITE}/wiki/api/v2/spaces`)).rejects.toBeInstanceOf(RequestCapExceeded);
    expect(stub.calls).toHaveLength(3);
    expect(r.count()).toBe(3);
  });

  it("counts each redirect hop against the cap", async () => {
    const stub = makeStub(baseModel());
    const r = requesterFor(stub, { maxRequests: 1 });
    await expect(
      r.request("GET", `${SITE}/wiki/rest/api/content/11/child/attachment/att1/data`, { wantBytes: true })
    ).rejects.toBeInstanceOf(RequestCapExceeded);
    expect(stub.calls).toHaveLength(1);
  });

  it("a probe that hits the cap stops and says so", async () => {
    const stub = makeStub(baseModel());
    const requester = requesterFor(stub, { maxRequests: 10 });
    const recorder = await runProbe({ request: requester.request, mode: "site", origin: SITE, pages: ["11"], blogposts: [], versionsPerId: 6 });
    expect(requester.count()).toBe(10);
    expect(recorder.state.aborted).toMatch(/cap/);
    expect(renderReport(recorder, { mode: "site", requests: 10, cap: 10 })).toContain("ABORTED");
  });

  it("paces requests with the configured delay", async () => {
    const sleeps = [];
    const stub = makeStub(baseModel());
    const r = requesterFor(stub, { delayMs: 250, sleep: async (ms) => void sleeps.push(ms) });
    for (let i = 0; i < 4; i += 1) await r.request("GET", `${SITE}/wiki/api/v2/spaces`);
    expect(sleeps).toEqual([250, 250, 250]);
  });

  it("the planned maximum bounds the actual count, and a typical run stays under the cap", async () => {
    const model = baseModel({ 1: content(), 2: content(), 3: content(), 4: content(), 5: content(), 6: content(), 7: content() });
    for (const mode of ["site", "gateway"]) {
      const { requester } = await runWith(model, { mode, pages: ["1", "2", "3", "4", "5"], blogposts: ["6", "7"] });
      const total = allocateVersions(7, 6, VERSION_CAP).reduce((a, b) => a + b, 0);
      const planned = planRequests({ itemCount: 7, versionsTotal: total, mode });
      expect(requester.count()).toBeLessThanOrEqual(planned);
      expect(planned).toBeLessThanOrEqual(REQUEST_CAP);
    }
    expect(planRequests({ itemCount: 7, versionsTotal: 30, mode: "site" })).toBe(124);
  });

  it("plans over the cap are detectable before running", () => {
    expect(planRequests({ itemCount: 20, versionsTotal: 30, mode: "site" })).toBeGreaterThan(REQUEST_CAP);
  });
});

describe("version sampling", () => {
  it("allocations respect the per-item and total caps (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 30 }), (items, perId) => {
        const alloc = allocateVersions(items, perId, VERSION_CAP);
        expect(alloc).toHaveLength(items);
        expect(alloc.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(VERSION_CAP);
        for (const n of alloc) expect(n).toBeLessThanOrEqual(perId);
      }),
      { seed: 760, numRuns: 200 }
    );
  });

  it("samples are sorted, bounded, drawn from the input and keep first and last (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 500 }), { maxLength: 60 }), fc.integer({ min: 0, max: 12 }), (nums, k) => {
        const s = selectVersionSamples(nums, k);
        expect(s.length).toBeLessThanOrEqual(k);
        expect([...s].sort((a, b) => a - b)).toEqual(s);
        for (const n of s) expect(nums).toContain(n);
        if (k >= 2 && nums.length > 0) {
          expect(s[0]).toBe(Math.min(...nums));
          expect(s[s.length - 1]).toBe(Math.max(...nums));
        }
      }),
      { seed: 760, numRuns: 200 }
    );
  });
});

describe("version-number echo and body hashes", () => {
  it("detects a v2 answer that echoes a different version", async () => {
    const { recorder, report } = await runWith(baseModel(), { pages: ["11"], blogposts: [], stubOpts: { echoOffBy: 8 } });
    const rows = recorder.bodyRows;
    expect(rows.length).toBeGreaterThan(2);
    const bad = rows.filter((r) => r.echo2 === false);
    expect(bad.map((r) => r.version)).toEqual([8]);
    expect(rows.filter((r) => r.echo2 === true)).toHaveLength(rows.length - 1);
    expect(report).toMatch(/v2 echoed the requested version: \d+\/\d+/);
    expect(report).not.toContain(`echoed the requested version: ${rows.length}/${rows.length}`);
    const cell = recorder.rows.site.get("R7");
    expect(cell.checks.echo.ok).toBe(cell.checks.echo.total - 1);
  });

  it("detects a body that differs by one byte and reports both hashes", async () => {
    const { recorder, report } = await runWith(baseModel(), { pages: ["11"], blogposts: [], stubOpts: { mutateV2Body: 8 } });
    const bad = recorder.bodyRows.filter((r) => r.equal === false);
    expect(bad.map((r) => r.version)).toEqual([8]);
    expect(bad[0].h1).toBe(sha256Hex("<p>version 8</p>").slice(0, 12));
    expect(bad[0].h2).toBe(sha256Hex("<p>version 8</p>!").slice(0, 12));
    expect(report).toContain(bad[0].h1);
    expect(report).toContain(bad[0].h2);
    expect(report).toMatch(/Byte-identical: \d+\/\d+ compared/);
  });

  it("reports full parity when v1 and v2 agree", async () => {
    const { recorder } = await runWith(baseModel(), { pages: ["11"], blogposts: [] });
    expect(recorder.bodyRows.every((r) => r.equal === true && r.echo2 === true)).toBe(true);
    for (const row of ["R1", "R5", "R8", "R14"]) {
      const cell = recorder.rows.site.get(row);
      for (const c of Object.values(cell.checks)) expect(c.ok).toBe(c.total);
    }
  });

  it("compareBodies tolerates missing fields", () => {
    expect(compareBodies(3, {}, {})).toEqual({ h1: null, h2: null, equal: false, echo1: null, echo2: null });
  });
});

describe("gateway mode", () => {
  it("records the status of each v1 GET (410) and the v2 status, asking v1 once per row", async () => {
    const { stub, recorder, report } = await runWith(baseModel(), { mode: "gateway", stubOpts: { v1Gone: true } });
    expect(new Set(stub.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
    expect(stub.calls.every((c) => c.url.startsWith(`${GATEWAY}/`))).toBe(true);

    for (const row of ["R1", "R5", "R7", "R8", "R10", "R12", "R13", "R14", "R15", "R16"]) {
      const cell = recorder.rows.gateway.get(row);
      expect(cell, row).toBeDefined();
      expect(cell.v1).toEqual({ 410: 1 });
    }
    for (const row of ["R1", "R5", "R8"]) expect(recorder.rows.gateway.get(row).v2).toEqual({ 200: 3 });
    expect(recorder.rows.gateway.get("R16").v2).toEqual({ 200: 1 });

    const v1Calls = stub.calls.filter((c) => c.url.includes("/wiki/rest/api/"));
    expect(v1Calls.length).toBeLessThanOrEqual(14);
    expect(report).toContain("410x1");
    expect(report).toContain("200x3");
    // v2 bodies are hashed even though the v1 side is gone
    expect(recorder.bodyRows.length).toBeGreaterThan(0);
    expect(recorder.bodyRows.every((r) => r.h2 !== null && r.equal === null)).toBe(true);
  });

  it("marks the other mode's columns as not run", async () => {
    const { report } = await runWith(baseModel(), { mode: "gateway", stubOpts: { v1Gone: true } });
    expect(report).toContain("not run in this mode");
  });

  it("stops on HTTP 429 and says so", async () => {
    const fetchImpl = async () => new Response("{}", { status: 429 });
    const r = createRequester({ fetchImpl, authorization: AUTH, credentialedPrefixes: [`${SITE}/`] });
    const recorder = await runProbe({ request: r.request, mode: "site", origin: SITE, pages: ["11"], blogposts: [], versionsPerId: 2 });
    expect(r.count()).toBe(1);
    expect(recorder.state.aborted).toMatch(/429/);
  });
});

describe("output never carries response content", () => {
  const word = (prefix) => fc.stringMatching(/^[A-Za-z0-9]{8,16}$/).map((s) => `${prefix}${s}`);

  it("omits titles, names, bodies, space keys, filenames, labels and hosts (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          title: word("TTL"),
          author: word("AUT"),
          message: word("MSG"),
          bodyText: word("BDY"),
          spaceKey: word("SPK"),
          spaceName: word("SPN"),
          user: word("USR"),
          email: word("EML"),
          file: word("FIL"),
          label: word("LBL"),
          host: word("HST"),
        }),
        async (v) => {
          const c = content({
            title: v.title,
            attachments: [{ id: "att1", title: v.file, size: 500, mediaType: "text/plain" }],
            labels: [v.label],
            body: (n) => `<p>${v.bodyText} ${n}</p>`,
            versions: [3, 2, 1].map((n) => ({ n, author: v.author, accountId: `acc-${n}`, when: `2026-01-0${n}T10:00:00.000Z`, message: `${v.message}${n}` })),
          });
          const model = { content: { 11: c, 21: c }, spaceKey: v.spaceKey, spaceName: v.spaceName, userName: v.user, email: v.email };
          const origin = `https://${v.host.toLowerCase()}.example.test`;
          const stub = makeStub(model);
          // Route the stub's fixed host to the random one.
          const fetchImpl = (url, init) => stub.fetchImpl(String(url).replace(origin, SITE), init);
          const requester = createRequester({ fetchImpl, authorization: AUTH, credentialedPrefixes: [`${origin}/`] });
          const recorder = await runProbe({ request: requester.request, mode: "site", origin, pages: ["11"], blogposts: ["21"], versionsPerId: 3 });
          const report = renderReport(recorder, { mode: "site", date: "2026-11-22", requests: requester.count(), cap: REQUEST_CAP, scopes: [] });

          expect(recorder.bodyRows.length).toBeGreaterThan(0); // the run did real work
          for (const secret of Object.values(v)) expect(report).not.toContain(secret);
          expect(report).not.toContain(origin);
          expect(report).not.toContain("example.test");
          expect(report).not.toContain("<p>");
        }
      ),
      { seed: 760, numRuns: 25 }
    );
  });

  it("the committed template has every row marked not run yet", () => {
    const md = renderReport(null);
    for (const row of INVENTORY) expect(md).toContain(`| ${row.id} |`);
    const dataRows = md.split("\n").filter((l) => /^\| R\d+ /.test(l));
    expect(dataRows).toHaveLength(INVENTORY.length);
    for (const l of dataRows) expect(l.split("not run yet").length - 1).toBeGreaterThanOrEqual(3);
  });
});

describe("argument parsing", () => {
  const base = ["--profile", "some-profile", "--pages", "1,2"];

  it("applies defaults and validates", () => {
    const a = parseCliArgs(base);
    expect(a).toMatchObject({ mode: "site", versions: 6, pages: ["1", "2"], blogposts: [] });
    expect(parseCliArgs([...base, "--blogposts", "3", "--gateway", "--scopes", "read:page:confluence,read:space:confluence"])).toMatchObject({
      mode: "gateway",
      scopes: ["read:page:confluence", "read:space:confluence"],
    });
  });

  it("rejects bad input without echoing it", () => {
    const bad = [
      [],
      ["--profile", "Bad_Name", "--pages", "1"],
      ["--profile", "p"],
      ["--profile", "p", "--pages", "abc"],
      [...base, "--versions", "31"],
      [...base, "--versions", "0"],
      [...base, "--delay-ms", "5"],
      [...base, "--scopes", "read:page:confluence"],
      [...base, "--unknown"],
    ];
    for (const argv of bad) expect(() => parseCliArgs(argv)).toThrow(UsageError);
    try {
      parseCliArgs(["--profile", "Bad_Name", "--pages", "1"]);
    } catch (e) {
      expect(e.message).not.toContain("Bad_Name");
    }
  });
});
