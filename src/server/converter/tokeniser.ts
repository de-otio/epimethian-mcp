/**
 * Storage→token tokeniser.
 *
 * Walks Confluence storage XML and replaces every <ac:>/<ri:>/<time>
 * element (and any element the converter can't represent) with an
 * opaque <!--epi:T####--> token, building a sidecar map of token ID
 * to verbatim outer XML.
 *
 * Stream 0: stub. Stream 3 implements.
 */

import type { TokenSidecar } from "./types.js";

export interface TokeniseResult {
  /** Markdown body with tokens in place of opaque elements. */
  canonical: string;
  /** Map from token ID to verbatim outer XML of the original element. */
  sidecar: TokenSidecar;
}

/**
 * Tokenise a Confluence storage-format string into canonical
 * token-augmented markdown plus the sidecar.
 */
export function tokeniseStorage(_storage: string): TokeniseResult {
  throw new Error("tokeniseStorage: not implemented (Stream 3)");
}
