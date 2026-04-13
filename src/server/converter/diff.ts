/**
 * Token-aware diff between caller's markdown and the canonical pre-edit
 * markdown for an existing page. Drives the data-preservation invariant
 * inside update_page.
 *
 * NOTE: this is the converter's own diff module, distinct from the
 * top-level src/server/diff.ts which handles storage-format diffing
 * for the diff_page_versions tool.
 *
 * Stream 0: stub. Stream 4 implements.
 */

import type { TokenDiff, TokenSidecar } from "./types.js";

/**
 * Compare the caller's markdown body against the canonical pre-edit
 * markdown produced by tokenising the page's current storage. Returns
 * a TokenDiff classifying every token.
 */
export function diffTokens(
  _canonical: string,
  _callerMd: string,
  _sidecar: TokenSidecar
): TokenDiff {
  throw new Error("diffTokens: not implemented (Stream 4)");
}
