/**
 * Contract C1 (plans/next-release-sdk2-and-v2-api.md §4): the one place an
 * API request base is derived. Every REST URL in `confluence-client.ts` is
 * built from `Config.apiV2`, `Config.apiV1` (via `requireV1`) or
 * `requestBaseFor` — never from the site URL directly. Human-facing links
 * (`webui`, macro parameters) keep using the site URL.
 *
 * Pure: no I/O, no config singleton.
 */

import type { ApiMode, Feature } from "./api-capabilities.js";

export type { ApiMode } from "./api-capabilities.js";

/** Atlassian's API gateway. Gateway requests go to `${GATEWAY_ORIGIN}/ex/confluence/{cloudId}`. */
export const GATEWAY_ORIGIN = "https://api.atlassian.com";

/** Atlassian cloudIds are UUIDs; anything else must not reach a URL path. */
const CLOUD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RequestBaseInput {
  /** Site URL without trailing slash, e.g. `https://example.atlassian.net`. */
  readonly url: string;
  /** Absent is treated as "site" (test fixtures and pre-7.6 configs). */
  readonly apiMode?: ApiMode;
  /** Tenant seal. Required in gateway mode; never taken from user input. */
  readonly sealedCloudId?: string;
}

/**
 * Origin + path prefix that every credentialed request starts with.
 *   site:    the site URL, unchanged (`https://example.atlassian.net`)
 *   gateway: `https://api.atlassian.com/ex/confluence/{sealedCloudId}`
 */
export function requestBaseFor(input: RequestBaseInput): string {
  if (input.apiMode === "gateway") {
    const cloudId = input.sealedCloudId;
    if (!cloudId || !CLOUD_ID_RE.test(cloudId)) {
      throw new Error(
        "Gateway mode needs the tenant seal (a cloudId stored at setup). " +
          "Run `epimethian-mcp setup` for this profile."
      );
    }
    return `${GATEWAY_ORIGIN}/ex/confluence/${cloudId}`;
  }
  return input.url;
}

export interface ApiBases {
  readonly apiMode: ApiMode;
  readonly apiV2: string;
  /** `null` in gateway mode: v1 answers 410 there (plan §2). */
  readonly apiV1: string | null;
}

/** The `Config` fields of contract C1, derived from one request base. */
export function buildApiBases(input: RequestBaseInput): ApiBases {
  const base = requestBaseFor(input);
  if (input.apiMode === "gateway") {
    return { apiMode: "gateway", apiV2: `${base}/wiki/api/v2`, apiV1: null };
  }
  return { apiMode: "site", apiV2: `${base}/wiki/api/v2`, apiV1: `${base}/wiki/rest/api` };
}

/**
 * A v1-only feature was called in gateway mode. Thrown before any request is
 * made; tool handlers map it to `message` unchanged.
 */
export class FeatureUnavailableInGatewayMode extends Error {
  readonly feature: Feature;
  constructor(feature: Feature) {
    super(
      `"${feature}" is not available in gateway mode (scoped API token): ` +
        `it needs the Confluence v1 REST API, which the Atlassian API gateway no longer serves.`
    );
    this.name = "FeatureUnavailableInGatewayMode";
    this.feature = feature;
  }
}

/**
 * The v1 base for `feature`, or a typed refusal when there is none. Every v1
 * call site goes through here, so `apiV1 === null` can never become the
 * string "null" in a URL.
 */
export function requireV1(cfg: { readonly apiV1: string | null }, feature: Feature): string {
  if (cfg.apiV1 === null) throw new FeatureUnavailableInGatewayMode(feature);
  return cfg.apiV1;
}

// --- Origin and prefix pinning (doc/design/gateway-mode.md §5) -------------

/** Percent-encoded `.`, `/` and `\` could let a gateway path climb out of its prefix after decoding. */
const ENCODED_TRAVERSAL_RE = /%2e|%2f|%5c/i;

/**
 * May the credential be sent to `url`? Pure; the one predicate behind request
 * pinning, pagination cursors and download redirects.
 *
 *   site (request base without a path): same origin as the base. Today's rule.
 *   gateway (request base `…/ex/confluence/{sealedCloudId}`): same origin AND the
 *     normalised path is below the base path, with the slash boundary
 *     (`…/{id}x/…` is not below `…/{id}`). Encoded dots, slashes and backslashes
 *     are refused, so no decoding step can climb out of the prefix.
 *
 * Anything unparseable is refused.
 */
export function isCredentialedUrl(url: string, requestBase: string): boolean {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(requestBase);
  } catch {
    return false;
  }
  if (target.origin !== base.origin || target.origin === "null") return false;
  if (target.username !== "" || target.password !== "") return false;
  const prefix = base.pathname.replace(/\/+$/, "");
  if (prefix === "") return true;
  if (ENCODED_TRAVERSAL_RE.test(target.pathname)) return false;
  return target.pathname.startsWith(`${prefix}/`);
}

/** A request was about to carry the credential somewhere it must never go. */
export class CredentialOriginRefused extends Error {
  constructor(readonly target: string, readonly requestBase: string) {
    super(
      `Refusing to send credentials to ${safeOrigin(target)}: it is outside the pinned request base ${requestBase}.`
    );
    this.name = "CredentialOriginRefused";
  }
}

function safeOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.split("/").slice(0, 4).join("/")}`;
  } catch {
    return "an unparseable URL";
  }
}

/** Throw `CredentialOriginRefused` unless `url` passes `isCredentialedUrl`. Called before any request is sent. */
export function assertCredentialedUrl(url: string, requestBase: string): void {
  if (!isCredentialedUrl(url, requestBase)) throw new CredentialOriginRefused(url, requestBase);
}

/**
 * Resolve a `_links.next` cursor to an absolute URL that is safe to follow
 * with credentials, or null. Relative paths only (an absolute URL, a protocol-
 * relative one, a backslash or a scheme separator is never followed).
 *
 * Site: `{origin}{/wiki}{next}` (the `/wiki` context is added when the link
 * lacks it). Gateway: a link already starting with `/ex/` is taken as a full
 * path (and then refused unless it is under the sealed prefix); otherwise it
 * is resolved under the sealed prefix. The result must pass
 * `isCredentialedUrl`, so a cursor naming another cloudId is refused.
 *
 * Used by the v1 CQL search only. v2 list cursors go through the stricter
 * `resolveV2NextLink` (pagination-cursor.ts), which also pins the cursor to the
 * listing's own request path; both end with `isCredentialedUrl`.
 */
export function resolveNextLink(next: unknown, requestBase: string): string | null {
  if (typeof next !== "string") return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  if (next.includes("://") || next.includes("\\")) return null;
  try {
    const base = new URL(requestBase);
    const gateway = base.origin === GATEWAY_ORIGIN;
    let full: string;
    if (gateway && next.startsWith("/ex/")) {
      full = `${base.origin}${next}`;
    } else {
      // Build on the origin (plus the gateway prefix), not the configured URL,
      // so a base with a path or trailing slash cannot double the `/wiki` context.
      const root = gateway ? base.origin + base.pathname.replace(/\/+$/, "") : base.origin;
      const prefix = next.startsWith("/wiki/") ? "" : "/wiki";
      full = `${root}${prefix}${next}`;
    }
    return isCredentialedUrl(full, requestBase) ? full : null;
  } catch {
    return null;
  }
}
