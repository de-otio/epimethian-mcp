/**
 * Storage→token tokeniser.
 *
 * Walks Confluence storage XML depth-first and replaces every outer
 * <ac:*>, <ri:*>, and <time> element with an opaque token. The verbatim
 * outer XML of the replaced element (including whitespace, attribute
 * order, ac:macro-id UUIDs, CDATA sections, and all inner markup) is
 * captured byte-for-byte into a sidecar map. The sidecar is the only
 * trusted source for restoring the original XML.
 *
 * Tokenisation is outermost-first: once an element is tokenised, its
 * children are opaque (not recursed into). This means a panel macro
 * containing a nested code macro becomes a single token whose sidecar
 * entry is the full subtree.
 *
 * ---------------------------------------------------------------------
 * Token form: `[[epi:T0001]]` (ASCII brackets).
 *
 * The original design (see
 * doc/design/investigations/investigate-confluence-specific-elements/
 * 01-data-preservation.md) specified HTML-comment tokens
 * (`<!--epi:T0001-->`), but GFM table cells in markdown-it (the
 * downstream renderer used by the converter) are parsed with
 * `html: false`, which HTML-escapes the `<` characters in a comment
 * inside a cell — the token literal would be mangled to
 * `&lt;!--epi:T0001--&gt;` and the restore pass would fail to find it.
 * The ASCII bracket form passes through markdown-it unchanged in every
 * tested context (paragraphs, list items, table cells, headings), so
 * it is the compatible choice. The compatibility check is enforced by
 * a test in tokeniser.test.ts — if the table-cell check ever regresses,
 * that test is the alarm bell.
 * ---------------------------------------------------------------------
 */

import { parse } from "node-html-parser";
import type { HTMLElement, Node } from "node-html-parser";
import type { TokenSidecar } from "./types.js";

export interface TokeniseResult {
  /** Storage body with tokens in place of opaque elements. */
  canonical: string;
  /** Map from token ID to verbatim outer XML of the original element. */
  sidecar: TokenSidecar;
}

/** Regex matching an element's tag name qualifying it for tokenisation. */
const TOKENISE_TAG_RE = /^(AC:|RI:|TIME$)/i;

/**
 * Format a numeric token index as a zero-padded 4+ digit ID.
 * E.g. 1 → "T0001", 12345 → "T12345".
 */
function formatTokenId(n: number): string {
  return "T" + String(n).padStart(4, "0");
}

/**
 * Render a token literal for the given ID.
 * See the module header for why this format was chosen.
 */
export function tokenLiteral(id: string): string {
  return `[[epi:${id}]]`;
}

/**
 * Decide whether an element should be replaced with a token.
 * Matches any element in the `ac:` or `ri:` namespace, and the
 * standalone `<time>` element (Confluence date macro).
 */
function shouldTokenise(tagName: string): boolean {
  return TOKENISE_TAG_RE.test(tagName);
}

/**
 * Collect the byte ranges (into the original source string) of every
 * outermost tokenisable element, in document order. Children of a
 * tokenised element are NOT recursed into — the whole subtree belongs
 * to the parent token.
 */
function collectTokeniseRanges(
  nodes: Node[],
  ranges: Array<[number, number]>
): void {
  for (const node of nodes) {
    // Node type 1 = element
    if (node.nodeType !== 1) continue;
    const el = node as HTMLElement;
    // `tagName` is always a string for element nodes (nodeType 1).
    if (shouldTokenise(el.tagName)) {
      // `range` gives [start, end) offsets into the original source.
      ranges.push(el.range);
      // DO NOT recurse — children are opaque under this token.
      continue;
    }
    collectTokeniseRanges(el.childNodes, ranges);
  }
}

/**
 * Tokenise a Confluence storage-format string.
 *
 * Walks the XML with `node-html-parser`, replaces every outer
 * `<ac:*>`, `<ri:*>`, and `<time>` element with a sequentially-
 * numbered token, and records the element's verbatim outer XML in the
 * returned sidecar. Non-tokenised regions of the input are emitted
 * byte-for-byte unchanged.
 *
 * The returned canonical may be post-processed by downstream stages
 * (e.g. storage→markdown rendering); this function's only contract is
 * that `restoreFromTokens(canonical, sidecar)` returns the original
 * input byte-for-byte when the canonical is untouched.
 */
export function tokeniseStorage(storage: string): TokeniseResult {
  if (storage.length === 0) {
    return { canonical: "", sidecar: {} };
  }

  // node-html-parser's lowerCaseTagName: false preserves the literal
  // tag name on the node — we don't actually rely on this for output
  // (we use range slicing) but keeping the original case is cheaper
  // to reason about and matches the string we'll slice from.
  const root = parse(storage, { lowerCaseTagName: false });

  const ranges: Array<[number, number]> = [];
  collectTokeniseRanges(root.childNodes, ranges);

  if (ranges.length === 0) {
    return { canonical: storage, sidecar: {} };
  }

  // Ranges come out in document order because we walk depth-first in
  // document order and never recurse into already-captured subtrees.
  const sidecar: TokenSidecar = {};
  const parts: string[] = [];
  let cursor = 0;
  let counter = 1;

  for (const [start, end] of ranges) {
    if (start > cursor) {
      parts.push(storage.slice(cursor, start));
    }
    const id = formatTokenId(counter++);
    // Byte-for-byte slice of the original — whitespace, attribute
    // order, ac:macro-id UUIDs, CDATA sections all preserved.
    sidecar[id] = storage.slice(start, end);
    parts.push(tokenLiteral(id));
    cursor = end;
  }
  if (cursor < storage.length) {
    parts.push(storage.slice(cursor));
  }

  return {
    canonical: parts.join(""),
    sidecar,
  };
}
