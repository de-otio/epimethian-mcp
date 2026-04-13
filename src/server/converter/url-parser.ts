/**
 * Strict Confluence base URL host equality and page-link parsing.
 *
 * SECURITY: must use new URL() host equality after canonicalisation —
 * never substring/startsWith. See investigation 06-security.md #5.
 */

import type { ConfluencePageRef } from "./types.js";

/**
 * Default port by scheme. Used so that `https://host` and
 * `https://host:443` are treated as the same origin.
 */
const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
};

/**
 * Parse a URL safely. Returns null if the input is not a syntactically
 * valid absolute URL.
 */
function safeParseUrl(u: string): URL | null {
  if (typeof u !== "string" || u.length === 0) return null;
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

/**
 * Return the canonical (scheme, host, port) triple for origin comparison.
 * The host component comes from `URL#hostname`, which already:
 * - strips any userinfo (`user:pass@`),
 * - omits the port,
 * - lowercases ASCII,
 * - converts IDN domains to Punycode,
 * - percent-decodes Unicode hostname escapes.
 *
 * Note: if two inputs have different schemes (http vs https), they are
 * different origins — we do not coerce them.
 */
function canonicalOrigin(u: URL): string {
  const port = u.port || DEFAULT_PORTS[u.protocol] || "";
  // u.hostname already normalises IDN/percent-encoded/userinfo.
  // For IPv6 hosts, URL#hostname strips the surrounding brackets;
  // we re-add them so different IPv6 forms still normalise identically.
  const host = u.hostname.includes(":") ? `[${u.hostname}]` : u.hostname;
  return `${u.protocol}//${host}:${port}`;
}

/**
 * Page-link path pattern. Captures:
 *   1 = space key
 *   2 = content ID
 *   3 = optional trailing slug (ignored)
 *
 * The path must live under /wiki; Cloud URLs always have this prefix.
 * The space key is `[^/]+` — Confluence restricts this to alphanumerics
 * and underscores in practice, but we don't enforce that here; the
 * downstream emitter will re-escape if needed.
 */
const PAGE_PATH_RE =
  /^\/wiki\/spaces\/([^/]+)\/pages\/([0-9]+)(?:\/([^/]+))?\/?$/;

/**
 * Parse a URL and decide whether it refers to a page in the configured
 * Confluence base. Returns a structured ref if internal, null if external
 * or malformed.
 *
 * Recognised forms:
 *   {base}/wiki/spaces/{key}/pages/{id}
 *   {base}/wiki/spaces/{key}/pages/{id}/{slug}
 *   {base}/wiki/spaces/{key}/pages/{id}#{anchor}
 *   {base}/wiki/spaces/{key}/pages/{id}/{slug}#{anchor}
 */
export function parseConfluenceUrl(
  url: string,
  baseUrl: string
): ConfluencePageRef | null {
  const candidate = safeParseUrl(url);
  const base = safeParseUrl(baseUrl);
  if (!candidate || !base) return null;

  // Only http/https are considered for page-link rewriting.
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
    return null;
  }

  if (canonicalOrigin(candidate) !== canonicalOrigin(base)) return null;

  const pathMatch = candidate.pathname.match(PAGE_PATH_RE);
  if (!pathMatch) return null;

  const spaceKey = decodeURIComponent(pathMatch[1]);
  const contentId = pathMatch[2];
  // decodeURIComponent can throw on malformed %xx sequences; be defensive.
  let anchor: string | undefined;
  if (candidate.hash && candidate.hash.length > 1) {
    try {
      anchor = decodeURIComponent(candidate.hash.slice(1));
    } catch {
      // Preserve the raw (still-encoded) anchor rather than failing.
      anchor = candidate.hash.slice(1);
    }
  }

  const ref: ConfluencePageRef = { contentId, spaceKey };
  if (anchor !== undefined && anchor.length > 0) ref.anchor = anchor;
  return ref;
}
