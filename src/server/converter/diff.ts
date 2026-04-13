/**
 * Token-aware diff between caller's markdown and the canonical pre-edit
 * markdown for an existing page. Drives the data-preservation invariant
 * inside update_page.
 *
 * NOTE: this is the converter's own diff module, distinct from the
 * top-level src/server/diff.ts which handles storage-format diffing
 * for the diff_page_versions tool.
 *
 * Stream 4: token-diff implementation.
 *
 * The diff classifies every `[[epi:T####]]` token seen across the
 * canonical (pre-edit) and caller (submitted) strings into one of four
 * disjoint buckets:
 *
 *   - preserved — token ID present in both canonical and caller
 *   - deleted   — token ID present in canonical but absent from caller
 *                 (explicit deletion; caller removed the token)
 *   - reordered — subset of preserved: token whose relative position in
 *                 the caller differs from its position in the canonical
 *   - invented  — token ID present in caller but not in the sidecar;
 *                 treated as caller forgery upstream
 *
 * The sidecar is the authoritative source for which IDs are valid. The
 * canonical is the authoritative source for which IDs existed in the
 * pre-edit document (a sidecar entry is created for every tokenised
 * element, so canonical-IDs ⊆ sidecar-keys).
 *
 * Duplicate references in the caller (the same token appearing more
 * than once — allowed by the restore contract) are collapsed to a
 * single entry in the preserved bucket.
 */

import type { TokenDiff, TokenId, TokenSidecar } from "./types.js";

/**
 * Matches a single token of the form `[[epi:T<digits>]]`. Kept in sync
 * with the regex in tokeniser.ts / restore.ts.
 */
const TOKEN_RE = /\[\[epi:(T\d+)\]\]/g;

/**
 * Extract every token ID from `s`, in document order, preserving
 * duplicates (so we can later decide what "reordered" means).
 */
function extractTokens(s: string): TokenId[] {
  if (s.length === 0) return [];
  const ids: TokenId[] = [];
  for (const m of s.matchAll(TOKEN_RE)) {
    ids.push(m[1]!);
  }
  return ids;
}

/**
 * Return the first-occurrence ordering of `ids`: the sequence of unique
 * token IDs in the order they first appear. Used by the reordering
 * detector so that duplicate caller references don't spuriously mark a
 * token as reordered.
 */
function firstOccurrenceOrder(ids: TokenId[]): TokenId[] {
  const seen = new Set<TokenId>();
  const out: TokenId[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Compute the token-level diff between canonical pre-edit markdown and
 * the caller's submitted markdown.
 *
 * @param canonical pre-edit canonical markdown produced by
 *   `tokeniseStorage(currentStorage).canonical`. Contains `[[epi:T####]]`
 *   tokens at their original positions.
 * @param callerMd caller's submitted markdown body.
 * @param sidecar token-id → verbatim-outer-XML map from the same
 *   tokenise pass that produced `canonical`.
 */
export function diffTokens(
  canonical: string,
  callerMd: string,
  sidecar: TokenSidecar
): TokenDiff {
  const canonicalTokens = extractTokens(canonical);
  const callerTokens = extractTokens(callerMd);

  // Canonical's token-ID set is authoritative for what existed pre-edit.
  // Caller IDs that aren't in the sidecar are caller forgery (invented).
  const canonicalSet = new Set<TokenId>(canonicalTokens);
  const callerSet = new Set<TokenId>(callerTokens);

  const preserved: TokenId[] = [];
  const deleted: TokenId[] = [];
  const invented: TokenId[] = [];

  // Walk the canonical (first-occurrence order) so preserved / deleted
  // come out in a stable, caller-facing order that mirrors the original
  // document layout.
  for (const id of firstOccurrenceOrder(canonicalTokens)) {
    if (callerSet.has(id)) {
      preserved.push(id);
    } else {
      deleted.push(id);
    }
  }

  // Invented = caller IDs not present in the sidecar. The sidecar is
  // the trusted allowlist — we don't fall back to the canonical set
  // because the sidecar may (by contract) be a strict superset of
  // canonical token IDs.
  const inventedSeen = new Set<TokenId>();
  for (const id of callerTokens) {
    if (inventedSeen.has(id)) continue;
    if (!Object.prototype.hasOwnProperty.call(sidecar, id)) {
      inventedSeen.add(id);
      invented.push(id);
    }
  }

  // Reordering: compute the subsequence of the caller's first-occurrence
  // order restricted to preserved IDs; compare to the canonical's first-
  // occurrence order restricted to preserved IDs. Any ID whose index
  // differs between the two sequences is classified as reordered.
  const preservedSet = new Set<TokenId>(preserved);
  const canonicalOrder = firstOccurrenceOrder(canonicalTokens).filter((id) =>
    preservedSet.has(id)
  );
  const callerOrder = firstOccurrenceOrder(callerTokens).filter((id) =>
    preservedSet.has(id)
  );

  const reordered: TokenId[] = [];
  if (canonicalOrder.length === callerOrder.length) {
    // Pairwise index comparison captures "same set, different order"
    // exactly. If the arrays are identical, reordered is empty; if any
    // index differs, that token moved.
    for (let i = 0; i < canonicalOrder.length; i++) {
      if (canonicalOrder[i] !== callerOrder[i]) {
        reordered.push(canonicalOrder[i]!);
      }
    }
  }
  // If lengths differ (shouldn't — preservedSet drives both), we leave
  // reordered empty; the caller will already be looking at `deleted`
  // or `invented` anyway.

  // Canonical set is unused after the walk but retained to make the
  // intent obvious when reading: preserved ⊆ canonicalSet, deleted ⊆
  // canonicalSet, invented ∩ canonicalSet = ∅.
  void canonicalSet;

  return { preserved, deleted, reordered, invented };
}
