// Pure logic for the live v1/v2 parity probe (scripts/live/v2-parity.mjs).
//
// Everything here takes its I/O as arguments (a `fetch` implementation, a
// sleep function), so it is tested offline against stubbed responses. The CLI
// wrapper is the only place that reads credentials or touches the network.
//
// Hard rules, enforced in code and covered by tests:
//   - Only GET and HEAD requests ever reach `fetch` (see createRequester).
//   - A hard request cap; the run aborts rather than exceed it.
//   - Output contains counts, statuses, booleans and hashes only. Free-form
//     response values (titles, names, bodies, space keys, hosts) never flow
//     into the report; they are compared and dropped.

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

export const REQUEST_CAP = 150;
export const VERSION_CAP = 30;
export const DEFAULT_VERSIONS = 6;
export const DEFAULT_DELAY_MS = 400;
export const MIN_DELAY_MS = 100;
export const MAX_REDIRECTS = 3;
export const MAX_JSON_BYTES = 10_000_000;
export const MAX_DOWNLOAD_BYTES = 2_000_000;
export const SMALL_ATTACHMENT_BYTES = 1_000_000;
export const LIST_LIMIT = 100;

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ID_RE = /^\d{1,20}$/;
const ATTACHMENT_ID_RE = /^(att)?\d{1,20}$/;
const SPACE_KEY_RE = /^[A-Za-z0-9~_.-]{1,255}$/;
const SCOPES_RE = /^[a-z][a-z0-9.:_-]*(,[a-z][a-z0-9.:_-]*)*$/;

// ---------------------------------------------------------------------------
// Errors (messages never carry URLs, hosts or response content)
// ---------------------------------------------------------------------------

export class ReadOnlyViolation extends Error {
  constructor() {
    super("refusing a request whose method is not GET or HEAD");
    this.name = "ReadOnlyViolation";
  }
}

export class RequestCapExceeded extends Error {
  constructor(cap) {
    super(`request cap of ${cap} reached`);
    this.name = "RequestCapExceeded";
  }
}

export class AbortRun extends Error {
  constructor(reason) {
    super(reason);
    this.name = "AbortRun";
  }
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const short = (hex) => (hex ? hex.slice(0, 12) : null);

// ---------------------------------------------------------------------------
// Request helper: GET/HEAD only, capped, paced, credential-latched
// ---------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} o
 * @param {typeof fetch} o.fetchImpl
 * @param {string} o.authorization        full Authorization header value
 * @param {string[]} o.credentialedPrefixes  URL prefixes (ending in "/") that may receive it
 * @param {number} [o.maxRequests]
 * @param {number} [o.delayMs]
 * @param {(ms:number)=>Promise<void>} [o.sleep]
 */
export function createRequester({
  fetchImpl,
  authorization,
  credentialedPrefixes,
  maxRequests = REQUEST_CAP,
  delayMs = 0,
  sleep = defaultSleep,
}) {
  let count = 0;
  const prefixes = credentialedPrefixes.map((p) => new URL(p).href);
  const isCredentialed = (url) => {
    let href;
    try {
      href = new URL(url).href;
    } catch {
      return false;
    }
    return prefixes.some((p) => href.startsWith(p));
  };

  async function drain(res) {
    try {
      await res.body?.cancel();
    } catch {
      // nothing to do
    }
  }

  /**
   * One logical request. Redirects are followed by hand (at most MAX_REDIRECTS)
   * and each hop counts against the cap. The Authorization header goes only to
   * URLs under a credentialed prefix, so a redirect to a signed media host
   * never carries the credential.
   */
  async function request(method, url, { wantBytes = false, maxBytes = MAX_JSON_BYTES } = {}) {
    const m = typeof method === "string" ? method.toUpperCase() : "";
    // Checked before anything else: no counting, no fetch.
    if (m !== "GET" && m !== "HEAD") throw new ReadOnlyViolation();

    let current = url;
    let hops = 0;
    for (;;) {
      if (count >= maxRequests) throw new RequestCapExceeded(maxRequests);
      if (count > 0 && delayMs > 0) await sleep(delayMs);
      count += 1;

      const headers = { Accept: wantBytes ? "*/*" : "application/json" };
      if (isCredentialed(current)) headers.Authorization = authorization;

      let res;
      try {
        res = await fetchImpl(current, { method: m, redirect: "manual", headers });
      } catch {
        return { status: 0 }; // network failure; the error text could name a host
      }

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await drain(res);
        if (hops >= MAX_REDIRECTS) return { status: res.status, redirectsExhausted: true };
        try {
          current = new URL(location, current).toString();
        } catch {
          return { status: res.status };
        }
        hops += 1;
        continue;
      }

      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await drain(res);
        return { status: res.status, tooLarge: true };
      }
      let buf;
      try {
        buf = Buffer.from(await res.arrayBuffer());
      } catch {
        return { status: res.status };
      }
      if (buf.length > maxBytes) return { status: res.status, tooLarge: true };

      const result = { status: res.status, bytes: buf.length, sha256: sha256Hex(buf) };
      if (!wantBytes) {
        try {
          result.json = JSON.parse(buf.toString("utf8"));
        } catch {
          // not JSON (an error page, say): status only
        }
      }
      return result;
    }
  }

  return { request, count: () => count, cap: maxRequests };
}

// ---------------------------------------------------------------------------
// Sampling and request planning
// ---------------------------------------------------------------------------

/** Evenly spaced sample of `k` version numbers, always including first and last. */
export function selectVersionSamples(numbers, k) {
  const sorted = [...new Set(numbers.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  if (k <= 0 || sorted.length === 0) return [];
  if (k >= sorted.length) return sorted;
  if (k === 1) return [sorted[sorted.length - 1]];
  const picked = new Set();
  for (let i = 0; i < k; i += 1) picked.add(sorted[Math.round((i * (sorted.length - 1)) / (k - 1))]);
  return [...picked].sort((a, b) => a - b);
}

/** Per-item version budgets: at most `perId` each and `cap` in total. */
export function allocateVersions(itemCount, perId, cap = VERSION_CAP) {
  if (itemCount <= 0) return [];
  const base = Math.min(perId, Math.floor(cap / itemCount));
  const extra = Math.min(cap - base * itemCount, itemCount);
  return Array.from({ length: itemCount }, (_, i) => (i < extra ? Math.min(perId, base + 1) : base));
}

/**
 * Upper bound on requests for a run (redirect hops included).
 * Site mode: 15 shared + 7 per item + 2 per sampled version.
 * Gateway mode: v1 is probed once per row (14), v2 on everything (3 per item,
 * 1 per sampled version, 6 shared).
 */
export function planRequests({ itemCount, versionsTotal, mode }) {
  const downloadSide = 1 + MAX_REDIRECTS;
  if (mode === "gateway") {
    return 14 + (3 * itemCount + versionsTotal + 2 + downloadSide);
  }
  return 7 + 2 * downloadSide + 7 * itemCount + 2 * versionsTotal;
}

// ---------------------------------------------------------------------------
// Inventory (plan section 5.4)
// ---------------------------------------------------------------------------

/** kind: compare = v1 and v2 read; v1only = v1 read, no v2; write = never probed; postread = v2 read that is a POST. */
export const INVENTORY = [
  { id: "R1", kind: "compare", name: "Attachment list", v1: "GET content/{id}/child/attachment", v2: "GET /pages|blogposts/{id}/attachments", scope: "read:attachment:confluence" },
  { id: "R2", kind: "compare", name: "Attachment download", v1: "GET content/{id}/child/attachment/{attId}/data", v2: "GET downloadLink (v2 attachment)", scope: "read:attachment:confluence" },
  { id: "R3", kind: "write", name: "Attachment upload", v1: "POST content/{id}/child/attachment", v2: "none", scope: "n/a", note: "write; never probed" },
  { id: "R4", kind: "write", name: "Attachment new version", v1: "POST content/{id}/child/attachment/{attId}/data", v2: "none", scope: "n/a", note: "write; never probed" },
  { id: "R5", kind: "compare", name: "Version list", v1: "GET content/{id}/version", v2: "GET /pages|blogposts/{id}/versions", scope: "read:page:confluence (blog posts: read:blogpost:confluence)" },
  { id: "R6", kind: "postread", name: "Version authors", v1: "inline in R5", v2: "POST /users-bulk", scope: "read:user:confluence", note: "POST read; not probed by the GET/HEAD-only rule" },
  { id: "R7", kind: "compare", name: "Historical body", v1: "GET content/{id}?version=N&expand=body.storage", v2: "GET /pages|blogposts/{id}?version=N&body-format=storage", scope: "read:page:confluence (blog posts: read:blogpost:confluence)" },
  { id: "R8", kind: "compare", name: "Labels read", v1: "GET content/{id}/label", v2: "GET /pages|blogposts/{id}/labels", scope: "read:label:confluence" },
  { id: "R9", kind: "write", name: "Labels write", v1: "POST/DELETE content/{id}/label", v2: "none", scope: "n/a", note: "write; never probed" },
  { id: "R10", kind: "v1only", name: "Content state read", v1: "GET content/{id}/state", v2: "none", scope: "n/a" },
  { id: "R11", kind: "write", name: "Content state write", v1: "PUT/DELETE content/{id}/state", v2: "none", scope: "n/a", note: "write; never probed" },
  { id: "R12", kind: "v1only", name: "CQL search", v1: "GET /search", v2: "none", scope: "n/a" },
  { id: "R13", kind: "v1only", name: "User search", v1: "GET /search/user", v2: "none (POST /users-bulk by id only)", scope: "n/a" },
  { id: "R14", kind: "compare", name: "Write-capability probe", v1: "GET user/current/permission/space/{key}", v2: "GET /spaces/{id}/operations", scope: "read:space:confluence" },
  { id: "R15", kind: "v1only", name: "Site locale", v1: "GET settings/systemInfo", v2: "none", scope: "n/a" },
  { id: "R16", kind: "compare", name: "Connection check", v1: "GET user/current", v2: "GET /spaces?limit=1", scope: "read:space:confluence" },
];

// ---------------------------------------------------------------------------
// Comparison (inputs are parsed JSON; outputs are booleans, counts, fixed labels)
// ---------------------------------------------------------------------------

const results = (json) => (json && Array.isArray(json.results) ? json.results : null);
const stripAtt = (id) => String(id).replace(/^att/, "");
const toMs = (value) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? null : ms;
};
const sliceMsg = (m) => (typeof m === "string" ? m.slice(0, 500) : "");

/** Field-wise comparison of two normalised, keyed lists. */
export function compareLists(a, b, fields) {
  const keysA = a.map((x) => x.key);
  const keysB = b.map((x) => x.key);
  const sameSet = keysA.length === keysB.length && [...keysA].sort().join("\0") === [...keysB].sort().join("\0");
  let orderRelation;
  if (keysA.length === 0 && keysB.length === 0) orderRelation = "empty";
  else if (!sameSet) orderRelation = "different-set";
  else if (keysA.join("\0") === keysB.join("\0")) orderRelation = "same";
  else if ([...keysA].reverse().join("\0") === keysB.join("\0")) orderRelation = "reversed";
  else orderRelation = "different-order";

  const byKey = new Map(b.map((x) => [x.key, x]));
  const mismatches = [];
  for (const x of a) {
    const y = byKey.get(x.key);
    if (!y) continue;
    for (const f of fields) if (x[f] !== y[f]) mismatches.push(f);
  }
  return {
    v1Count: a.length,
    v2Count: b.length,
    countEqual: a.length === b.length,
    orderRelation,
    mismatches,
  };
}

const normAttachmentV1 = (x) => ({
  key: stripAtt(x?.id), id: x?.id, title: x?.title, version: x?.version?.number,
  fileSize: x?.extensions?.fileSize, mediaType: x?.extensions?.mediaType,
});
const normAttachmentV2 = (x) => ({
  key: stripAtt(x?.id), id: x?.id, title: x?.title, version: x?.version?.number,
  fileSize: x?.fileSize, mediaType: x?.mediaType,
});
const normVersionV1 = (x) => ({
  key: String(x?.number), minorEdit: x?.minorEdit, message: sliceMsg(x?.message),
  author: x?.by?.accountId, when: toMs(x?.when),
});
const normVersionV2 = (x) => ({
  key: String(x?.number), minorEdit: x?.minorEdit, message: sliceMsg(x?.message),
  author: x?.authorId, when: toMs(x?.createdAt),
});
const normLabel = (x) => ({ key: `${x?.prefix}:${x?.name}`, id: x?.id === undefined ? undefined : String(x.id) });

const LIST_SPECS = {
  R1: { n1: normAttachmentV1, n2: normAttachmentV2, fields: ["id", "title", "version", "fileSize", "mediaType"] },
  R5: { n1: normVersionV1, n2: normVersionV2, fields: ["minorEdit", "message", "author", "when"] },
  R8: { n1: normLabel, n2: normLabel, fields: ["id"] },
};

/** Compare two list responses for row R1, R5 or R8. */
export function compareListResponses(rowId, json1, json2) {
  const spec = LIST_SPECS[rowId];
  const l1 = results(json1);
  const l2 = results(json2);
  if (!l1 || !l2) return { checks: { shape: false }, tallies: {}, mismatches: [] };
  const c = compareLists(l1.map(spec.n1), l2.map(spec.n2), spec.fields);
  const more1 = Boolean(json1?._links?.next);
  const more2 = Boolean(json2?._links?.next);
  return {
    checks: { count: c.countEqual, fields: c.mismatches.length === 0 && c.orderRelation !== "different-set" },
    tallies: {
      order: c.orderRelation,
      paging: more1 && more2 ? "both-more" : more1 ? "v1-more" : more2 ? "v2-more" : "single-page",
    },
    mismatches: c.mismatches,
    counts: { v1: c.v1Count, v2: c.v2Count },
  };
}

/** Hash and echo comparison for one historical body. */
export function compareBodies(version, json1, json2) {
  const body = (j) => (typeof j?.body?.storage?.value === "string" ? j.body.storage.value : null);
  const b1 = body(json1);
  const b2 = body(json2);
  const h1 = b1 === null ? null : sha256Hex(b1);
  const h2 = b2 === null ? null : sha256Hex(b2);
  return {
    h1,
    h2,
    equal: h1 !== null && h1 === h2,
    echo1: typeof json1?.version?.number === "number" ? json1.version.number === version : null,
    echo2: typeof json2?.version?.number === "number" ? json2.version.number === version : null,
  };
}

/** Does a permission response grant "create page"? null when the shape is unknown. */
export function createPermissionV1(json) {
  if (!json || typeof json !== "object") return null;
  if (json.havePermission === true) return true;
  if (json.havePermission === false) return false;
  if (Array.isArray(json.permissions)) {
    return json.permissions.some((p) => p?.operation?.operation === "create" && p?.operation?.targetType === "page");
  }
  return null;
}

export function createPermissionV2(json) {
  const ops = Array.isArray(json?.operations) ? json.operations : Array.isArray(json?.results) ? json.results : null;
  if (!ops) return null;
  return ops.some((o) => o?.operation === "create" && o?.targetType === "page");
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export function createRecorder() {
  const rows = { site: new Map(), gateway: new Map() };
  const bodyRows = [];
  const state = { aborted: null, itemCounts: { pages: 0, blogposts: 0 }, versionsSampled: 0 };

  const bump = (obj, key) => {
    obj[key] = (obj[key] ?? 0) + 1;
  };

  function add(rowId, mode, { v1, v2, checks = {}, tallies = {}, mismatches = [] } = {}) {
    const map = rows[mode];
    if (!map.has(rowId)) map.set(rowId, { v1: {}, v2: {}, checks: {}, tallies: {}, mismatches: {} });
    const cell = map.get(rowId);
    if (typeof v1 === "number") bump(cell.v1, v1);
    if (typeof v2 === "number") bump(cell.v2, v2);
    for (const [name, ok] of Object.entries(checks)) {
      const c = (cell.checks[name] ??= { ok: 0, total: 0 });
      c.total += 1;
      if (ok) c.ok += 1;
    }
    for (const [name, label] of Object.entries(tallies)) {
      cell.tallies[name] ??= {};
      bump(cell.tallies[name], label);
    }
    for (const f of mismatches) bump(cell.mismatches, f);
  }

  return { rows, bodyRows, state, add };
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {(method:string,url:string,opts?:object)=>Promise<{status:number,json?:any,sha256?:string}>} o.request
 * @param {"site"|"gateway"} o.mode
 * @param {string} o.origin      site origin, or the gateway prefix for the sealed cloud id
 * @param {string[]} o.pages
 * @param {string[]} o.blogposts
 * @param {number} o.versionsPerId
 */
export async function runProbe({ request, mode, origin, pages, blogposts, versionsPerId, recorder = createRecorder() }) {
  const gateway = mode === "gateway";
  const v1 = `${origin}/wiki/rest/api`;
  const v2 = `${origin}/wiki/api/v2`;
  const items = [
    ...pages.map((id, i) => ({ id, seg: "pages", tag: `p${i + 1}` })),
    ...blogposts.map((id, i) => ({ id, seg: "blogposts", tag: `b${i + 1}` })),
  ];
  recorder.state.itemCounts = { pages: pages.length, blogposts: blogposts.length };
  const alloc = allocateVersions(items.length, versionsPerId, VERSION_CAP);

  // Gateway mode asks v1 once per row: the question there is "410 or not".
  const v1Asked = new Set();
  const askV1 = (row) => {
    if (!gateway) return true;
    if (v1Asked.has(row)) return false;
    v1Asked.add(row);
    return true;
  };

  const get = async (url, opts) => {
    const res = await request("GET", url, opts);
    if (res.status === 429) throw new AbortRun("HTTP 429 from the server; stopped to stay polite");
    return res;
  };
  const ok = (res) => res && res.status >= 200 && res.status < 300;
  const record = (row, a, b, extra = {}) => recorder.add(row, mode, { v1: a?.status, v2: b?.status, ...extra });

  try {
    let smallAttachment = null;

    for (const [index, item] of items.entries()) {
      const { id, seg, tag } = item;

      // R1 attachments
      const a1 = askV1("R1") ? await get(`${v1}/content/${id}/child/attachment?limit=${LIST_LIMIT}&expand=version`) : null;
      const a2 = await get(`${v2}/${seg}/${id}/attachments?limit=${LIST_LIMIT}`);
      record("R1", a1, a2, ok(a1) && ok(a2) ? compareListResponses("R1", a1.json, a2.json) : {});
      if (!smallAttachment) {
        const candidates = [
          ...(ok(a2) ? (results(a2.json) ?? []).map((x) => ({ id: x?.id, size: x?.fileSize, link: x?.downloadLink })) : []),
          ...(ok(a1) ? (results(a1.json) ?? []).map((x) => ({ id: x?.id, size: x?.extensions?.fileSize, link: undefined })) : []),
        ];
        const found = candidates.find(
          (x) => typeof x.id === "string" && ATTACHMENT_ID_RE.test(x.id) && x.size > 0 && x.size <= SMALL_ATTACHMENT_BYTES
        );
        if (found) smallAttachment = { pageId: id, attId: found.id, link: found.link };
      }

      // R5 versions
      const ver1 = askV1("R5") ? await get(`${v1}/content/${id}/version?limit=${LIST_LIMIT}`) : null;
      const ver2 = await get(`${v2}/${seg}/${id}/versions?limit=${LIST_LIMIT}`);
      record("R5", ver1, ver2, ok(ver1) && ok(ver2) ? compareListResponses("R5", ver1.json, ver2.json) : {});

      // R8 labels
      const l1 = askV1("R8") ? await get(`${v1}/content/${id}/label?limit=${LIST_LIMIT}`) : null;
      const l2 = await get(`${v2}/${seg}/${id}/labels?limit=${LIST_LIMIT}`);
      record("R8", l1, l2, ok(l1) && ok(l2) ? compareListResponses("R8", l1.json, l2.json) : {});

      // R10 content state (v1 only)
      if (askV1("R10")) {
        const s1 = await get(`${v1}/content/${id}/state?status=current`);
        const label = !ok(s1) ? undefined : s1.json?.contentState ? "state-set" : "no-state";
        record("R10", s1, null, label ? { tallies: { state: label } } : {});
      }

      // R7 historical bodies
      const numbers = (ok(ver2) ? results(ver2.json) : ok(ver1) ? results(ver1.json) : null)?.map((x) => x?.number) ?? [];
      const samples = selectVersionSamples(numbers, alloc[index]);
      for (const n of samples) {
        recorder.state.versionsSampled += 1;
        const b1 = askV1("R7") ? await get(`${v1}/content/${id}?version=${n}&expand=body.storage,version`) : null;
        const b2 = await get(`${v2}/${seg}/${id}?version=${n}&body-format=storage`);
        const cmp = ok(b2) ? compareBodies(n, ok(b1) ? b1.json : undefined, b2.json) : null;
        const extra = ok(b1) && ok(b2) ? { checks: { hash: cmp.equal, echo: cmp.echo2 === true } } : {};
        record("R7", b1, b2, extra);
        recorder.bodyRows.push({
          item: tag,
          version: n,
          v1: b1 ? b1.status : null,
          v2: b2.status,
          h1: short(cmp?.h1),
          h2: short(cmp?.h2),
          equal: ok(b1) && ok(b2) ? cmp.equal : null,
          echo2: cmp ? cmp.echo2 : null,
        });
      }
    }

    // R16 connection check, and the space used by R14
    const c1 = await get(`${v1}/user/current`);
    const c2 = await get(`${v2}/spaces?limit=1`);
    record("R16", c1, c2);
    const space = results(c2.json)?.[0];
    const spaceId = typeof space?.id === "string" && ID_RE.test(space.id) ? space.id : null;
    const spaceKey = typeof space?.key === "string" && SPACE_KEY_RE.test(space.key) ? space.key : null;

    // R14 write-capability probe (read forms only)
    const p1 = spaceKey ? await get(`${v1}/user/current/permission/space/${encodeURIComponent(spaceKey)}?operationKey=create&targetType=page`) : null;
    const p2 = spaceId ? await get(`${v2}/spaces/${spaceId}/operations`) : null;
    if (p1 || p2) {
      let extra = {};
      if (ok(p1) && ok(p2)) {
        const a = createPermissionV1(p1.json);
        const b = createPermissionV2(p2.json);
        extra = { checks: { permission: a !== null && a === b } };
      }
      record("R14", p1, p2, extra);
    }

    // v1-only reads
    record("R15", await get(`${v1}/settings/systemInfo`), null);
    record("R12", await get(`${v1}/search?cql=${encodeURIComponent("type=page")}&limit=1`), null);
    record("R13", await get(`${v1}/search/user?cql=${encodeURIComponent('user.fullname~"a"')}&limit=1`), null);

    // R2 one small attachment, compared by SHA-256 of the bytes
    if (smallAttachment) {
      const link = smallAttachment.link;
      const usableLink = typeof link === "string" && link.startsWith("/") && !link.startsWith("//") && !link.includes("..");
      const d1 = await get(`${v1}/content/${smallAttachment.pageId}/child/attachment/${smallAttachment.attId}/data`, { wantBytes: true, maxBytes: MAX_DOWNLOAD_BYTES });
      const d2 = usableLink
        ? await get(`${origin}${link.startsWith("/wiki/") ? link : `/wiki${link}`}`, { wantBytes: true, maxBytes: MAX_DOWNLOAD_BYTES })
        : null;
      const both = ok(d1) && ok(d2) && d1.sha256 && d2.sha256;
      record("R2", d1, d2, both ? { checks: { hash: d1.sha256 === d2.sha256 } } : {});
    }
  } catch (err) {
    if (err instanceof AbortRun) recorder.state.aborted = err.message;
    else if (err instanceof RequestCapExceeded) recorder.state.aborted = err.message;
    else throw err;
  }
  return recorder;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const NOT_RUN = "not run yet";
// Escape backslashes first, then pipes, so a cell cannot end in an escape that eats the separator.
const mdCell = (s) => String(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
const statusLabel = (s) => (s === 0 ? "ERR" : String(s));

function histogram(h) {
  const entries = Object.entries(h).sort(([a], [b]) => Number(a) - Number(b));
  return entries.length === 0 ? "not probed" : entries.map(([s, n]) => `${statusLabel(Number(s))}x${n}`).join(", ");
}

function parityCell(cell) {
  const parts = [];
  for (const [name, c] of Object.entries(cell.checks)) parts.push(`${name} ${c.ok}/${c.total}`);
  for (const [name, t] of Object.entries(cell.tallies)) {
    parts.push(`${name}: ${Object.entries(t).map(([l, n]) => `${l}x${n}`).join(", ")}`);
  }
  const mm = Object.entries(cell.mismatches);
  if (mm.length) parts.push(`field mismatches: ${mm.map(([f, n]) => `${f}x${n}`).join(", ")}`);
  return parts.length ? parts.join("; ") : "-";
}

function modeCells(row, mode, recorder, runMode) {
  if (!recorder) return [NOT_RUN, NOT_RUN, NOT_RUN];
  if (row.kind === "write") return ["not probed (write)", "not probed (write)", "-"];
  if (row.kind === "postread") return ["-", "not probed (POST)", "-"];
  if (mode !== runMode) return ["not run in this mode", "not run in this mode", "-"];
  const cell = recorder.rows[mode].get(row.id);
  if (!cell) return ["no data", "no data", "-"];
  return [
    histogram(cell.v1),
    row.kind === "v1only" ? "n/a (no v2)" : histogram(cell.v2),
    parityCell(cell),
  ];
}

/**
 * Markdown for stdout and for the investigation document. With no recorder,
 * every result cell reads "not run yet" (this produces the committed template).
 * `meta`: { mode, date, requests, cap, scopes }.
 */
export function renderReport(recorder, meta = {}) {
  const lines = [];
  if (recorder) {
    const { itemCounts, versionsSampled, aborted } = recorder.state;
    lines.push("### Run summary", "");
    lines.push(`- Mode: ${meta.mode}`);
    if (meta.date) lines.push(`- Date: ${meta.date}`);
    lines.push(`- Items: ${itemCounts.pages} page(s), ${itemCounts.blogposts} blog post(s)`);
    lines.push(`- Requests: ${meta.requests} of a cap of ${meta.cap} (GET/HEAD only)`);
    lines.push(`- Versions sampled: ${versionsSampled} (cap ${VERSION_CAP})`);
    lines.push(`- Run status: ${aborted ? `ABORTED (${aborted})` : "complete"}`);
    if (meta.mode === "gateway") {
      lines.push(`- Token scopes declared by the person running: ${meta.scopes?.length ? meta.scopes.join(", ") : "none declared"}`);
    }
    lines.push("");
  }

  lines.push("### Parity matrix", "");
  lines.push("| # | Row | v1 call | v2 call | Site: v1 | Site: v2 | Site: parity | Gateway: v1 | Gateway: v2 | Gateway: parity | Expected v2 scope | Notes |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const row of INVENTORY) {
    const site = modeCells(row, "site", recorder, meta.mode);
    const gw = modeCells(row, "gateway", recorder, meta.mode);
    const cells = [row.id, row.name, row.v1, row.v2, ...site, ...gw, row.scope, row.note ?? ""];
    lines.push(`| ${cells.map(mdCell).join(" | ")} |`);
  }
  lines.push("");

  lines.push("### Historical bodies (R7)", "");
  lines.push("| Item | Version | v1 status | v2 status | v1 sha256 (first 12) | v2 sha256 (first 12) | Byte-identical | v2 echoes version |");
  lines.push("|---|---|---|---|---|---|---|---|");
  if (!recorder) {
    lines.push(`| ${NOT_RUN} | | | | | | | |`);
  } else if (recorder.bodyRows.length === 0) {
    lines.push("| (none sampled) | | | | | | | |");
  } else {
    const yn = (v) => (v === null ? "n/a" : v ? "yes" : "no");
    for (const r of recorder.bodyRows) {
      lines.push(
        `| ${r.item} | ${r.version} | ${r.v1 === null ? "not probed" : statusLabel(r.v1)} | ${statusLabel(r.v2)} | ${r.h1 ?? "-"} | ${r.h2 ?? "-"} | ${yn(r.equal)} | ${yn(r.echo2)} |`
      );
    }
    const compared = recorder.bodyRows.filter((r) => r.equal !== null);
    const identical = compared.filter((r) => r.equal).length;
    const echoed = recorder.bodyRows.filter((r) => r.echo2 === true).length;
    lines.push("", `Byte-identical: ${identical}/${compared.length} compared. v2 echoed the requested version: ${echoed}/${recorder.bodyRows.length}.`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

function idList(raw, flag) {
  if (raw === undefined) return [];
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!ids.every((id) => ID_RE.test(id))) throw new UsageError(`${flag} takes comma-separated numeric ids`);
  return ids;
}

export function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        profile: { type: "string" },
        pages: { type: "string" },
        blogposts: { type: "string" },
        versions: { type: "string" },
        gateway: { type: "boolean", default: false },
        scopes: { type: "string" },
        "delay-ms": { type: "string" },
      },
    }));
  } catch {
    throw new UsageError("unrecognised or malformed arguments");
  }
  if (!values.profile || !PROFILE_NAME_RE.test(values.profile)) {
    throw new UsageError("--profile <name> is required (lowercase letters, digits, hyphens)");
  }
  const pages = idList(values.pages, "--pages");
  const blogposts = idList(values.blogposts, "--blogposts");
  if (pages.length + blogposts.length === 0) throw new UsageError("give at least one id with --pages or --blogposts");

  const versions = values.versions === undefined ? DEFAULT_VERSIONS : Number(values.versions);
  if (!Number.isInteger(versions) || versions < 1 || versions > VERSION_CAP) {
    throw new UsageError(`--versions must be an integer from 1 to ${VERSION_CAP}`);
  }
  const delayMs = values["delay-ms"] === undefined ? DEFAULT_DELAY_MS : Number(values["delay-ms"]);
  if (!Number.isInteger(delayMs) || delayMs < MIN_DELAY_MS) {
    throw new UsageError(`--delay-ms must be an integer of at least ${MIN_DELAY_MS}`);
  }
  if (values.scopes !== undefined && !SCOPES_RE.test(values.scopes)) {
    throw new UsageError("--scopes takes comma-separated scope names such as read:page:confluence");
  }
  if (values.scopes !== undefined && !values.gateway) throw new UsageError("--scopes only applies with --gateway");

  return {
    profile: values.profile,
    pages,
    blogposts,
    versions,
    delayMs,
    mode: values.gateway ? "gateway" : "site",
    scopes: values.scopes ? values.scopes.split(",") : [],
  };
}
