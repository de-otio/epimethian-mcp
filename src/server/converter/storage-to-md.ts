/**
 * Confluence storage format → GFM markdown converter.
 *
 * Lossless via the tokeniser: macros and other opaque elements are
 * replaced with [[epi:T####]] tokens, with the verbatim XML stored
 * in a sidecar map for later restoration during update_page.
 *
 * Replaces the legacy toMarkdownView in confluence-client.ts (which
 * stripped macros to summary placeholders — lossy round-trip) for
 * the get_page format=markdown path.
 *
 * Flow:
 *   1. tokeniseStorage(storage) → { canonical, sidecar }
 *      The canonical has [[epi:T####]] in place of every <ac:>, <ri:>,
 *      and <time> element.
 *   2. Run turndown on the canonical HTML.
 *   3. Turndown escapes `[` to `\[`, which mangles [[epi:T####]].
 *      Post-process: unescape \[\[epi:T####\]\] → [[epi:T####]].
 *
 * Token form is [[epi:T####]] (ASCII brackets), not HTML comments.
 * See tokeniser.ts module header for why HTML-comment tokens were
 * rejected (GFM table cells with html:false mangle them).
 */

import TurndownService from "turndown";
import { tokeniseStorage } from "./tokeniser.js";
import type { TokenSidecar } from "./types.js";

export interface StorageToMarkdownResult {
  /** GFM markdown with [[epi:T####]] tokens for opaque elements. */
  markdown: string;
  /** Sidecar map for round-trip via update_page. */
  sidecar: TokenSidecar;
}

/**
 * Shared TurndownService instance configured for GFM output.
 * Heading style ATX (#), fenced code blocks, and table support.
 *
 * Turndown escapes `[` to `\[` by default (treating it as markdown
 * link syntax). Our tokens contain `[[epi:T####]]`, so post-processing
 * is required to unescape them. See storageToMarkdown below.
 */
function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  // Preserve <br> as a hard line break
  td.addRule("br", {
    filter: "br",
    replacement: () => "  \n",
  });

  return td;
}

/**
 * Convert Confluence storage XHTML to token-augmented GFM markdown.
 *
 * The returned markdown contains [[epi:T####]] tokens verbatim in place
 * of every Confluence-specific element. The sidecar maps each token ID
 * to the byte-for-byte verbatim XML of the replaced element.
 *
 * Lossless contract: any token present in the returned markdown can be
 * restored to its original storage XML via sidecar lookup. The markdown
 * body (non-token regions) is a GFM rendering of the plain HTML portions
 * of the storage document; those regions are not byte-perfect but are
 * semantically equivalent for display and editing purposes.
 */
export function storageToMarkdown(storage: string): StorageToMarkdownResult {
  if (storage.length === 0) {
    return { markdown: "", sidecar: {} };
  }

  // Step 1: Replace Confluence-specific elements with tokens.
  const { canonical, sidecar } = tokeniseStorage(storage);

  // Step 2: Run turndown on the canonical HTML.
  // The canonical is standard HTML (p, h1-h6, ul, ol, table, strong, em, a,
  // pre, code, etc.) with [[epi:T####]] tokens embedded as plain text.
  const td = makeTurndown();
  let markdown = td.turndown(canonical);

  // Step 3: Unescape tokens that turndown mangled.
  // Turndown escapes `[` → `\[` inside text content, so [[epi:T0001]] becomes
  // \[\[epi:T0001\]\]. We restore the tokens to their canonical form.
  // Pattern: \[\[epi:(T\d+)\]\]  →  [[epi:$1]]
  markdown = markdown.replace(/\\\[\\\[epi:(T\d+)\\\]\\\]/g, "[[epi:$1]]");

  return { markdown, sidecar };
}
