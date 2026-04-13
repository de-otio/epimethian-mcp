/**
 * GFM markdown → Confluence storage format converter.
 *
 * Uses markdown-it with a security-conservative configuration
 * (html: false by default), GFM extensions, and post-processing to
 * emit Confluence-native macros where appropriate (code blocks, ac:link
 * rewriting for Confluence URLs, allowlisted raw passthrough).
 *
 * Stream 0: stub. Stream 2 implements; Streams 7-11 add macro plugins.
 */

import type { ConverterOptions } from "./types.js";

/**
 * Convert a markdown string to Confluence storage format XHTML.
 *
 * @throws ConverterError on any input that would lose data, exceed
 *   the size cap, or violate security mitigations
 */
export function markdownToStorage(_md: string, _opts?: ConverterOptions): string {
  throw new Error("markdownToStorage: not implemented (Stream 2)");
}
