/**
 * Confluence storage format → GFM markdown converter.
 *
 * Lossless via the tokeniser: macros and other opaque elements are
 * replaced with <!--epi:T####--> tokens, with the verbatim XML stored
 * in a sidecar map for later restoration during update_page.
 *
 * Replaces the legacy storageToMarkdown in confluence-client.ts which
 * stripped macros to summary placeholders (lossy round-trip).
 *
 * Stream 0: stub. Stream 6 implements (depends on Stream 3 tokeniser).
 */

import type { TokenSidecar } from "./types.js";

export interface StorageToMarkdownResult {
  /** GFM markdown with <!--epi:T####--> tokens for opaque elements. */
  markdown: string;
  /** Sidecar map for round-trip via update_page. */
  sidecar: TokenSidecar;
}

/**
 * Convert Confluence storage XHTML to token-augmented GFM markdown.
 */
export function storageToMarkdown(_storage: string): StorageToMarkdownResult {
  throw new Error("storageToMarkdown: not implemented (Stream 6)");
}
