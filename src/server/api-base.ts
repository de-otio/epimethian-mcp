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
