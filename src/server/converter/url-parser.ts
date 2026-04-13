/**
 * Strict Confluence base URL host equality and page-link parsing.
 *
 * SECURITY: must use new URL() host equality after canonicalisation —
 * never substring/startsWith. See investigation 06-security.md #5.
 *
 * Stream 0: stub. Stream 1 implements.
 */

import type { ConfluencePageRef } from "./types.js";

/**
 * Parse a URL and decide whether it refers to a page in the configured
 * Confluence base. Returns a structured ref if internal, null if external.
 *
 * Recognised forms:
 *   {base}/wiki/spaces/{key}/pages/{id}
 *   {base}/wiki/spaces/{key}/pages/{id}/{slug}
 *   {base}/wiki/spaces/{key}/pages/{id}#{anchor}
 *   {base}/wiki/spaces/{key}/pages/{id}/{slug}#{anchor}
 */
export function parseConfluenceUrl(
  _url: string,
  _baseUrl: string
): ConfluencePageRef | null {
  throw new Error("parseConfluenceUrl: not implemented (Stream 1)");
}
