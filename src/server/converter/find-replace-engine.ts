/**
 * Find/replace engine for `find_replace` section edits (S1).
 *
 * Pure: no HTTP, no guards beyond the engine's own structural invariants.
 * The write-safety pipeline (safe-write.ts) wraps it with the deletion gate,
 * the fence/canary checks and the content-safety guards.
 *
 * Model. The section body is tokenised (every `<ac:*>`, `<ri:*>` and
 * `<time>` element becomes an opaque `[[epi:Tnnnn]]` placeholder) and every
 * pair is applied, in order, to that running tokenised form. Text inside a
 * macro is therefore never matched. At the end the placeholders are restored
 * from the sidecar in a single pass (`restoreFromTokens`), so XML restored
 * from one macro is never re-scanned for another placeholder.
 *
 * Matching (plans/field-session-findings-2026-10.md §3 contract 2):
 *   - An exact byte match is tried first. The fence-equivalent "view" match
 *     is used only when the exact count is 0.
 *   - The view transform is V(s) = concat over code points c of NFKD(c),
 *     minus the fence strip set (whatever `sanitiseTenantText` deletes).
 *     The fence applies NFKC and the strip set, and NFKD(NFKC(x)) = NFKD(x),
 *     so text an agent copied out of a fenced read matches its source.
 *     Known limit: combining marks stored in non-canonical order are not
 *     reordered, so such text only matches exactly.
 *   - Each find must match exactly once, counted in the space that matched,
 *     overlapping occurrences included. `replace_all: true` opts in to
 *     several (non-overlapping) occurrences.
 *   - A match must not split a surrogate pair, must start and end on view
 *     piece boundaries, and must not partly overlap a placeholder.
 *   - Byte preservation (view matches): the longest common prefix and suffix
 *     of `find` and `replace`, compared in view space, keep the stored bytes;
 *     only the differing middle takes the caller's bytes. `replace = find +
 *     new` therefore never rewrites the anchor.
 *
 * Invariants enforced here (all throw ConverterError; nothing is returned):
 *   - the page text holds no `[[epi:` literal (PLACEHOLDER_LITERAL_IN_PAGE);
 *   - every `[[epi:` in a replacement, and in the final running form, is a
 *     placeholder the sidecar knows (FORGED_TOKEN);
 *   - no placeholder occurs twice in the result (DUPLICATED_TOKEN): a copy
 *     would duplicate the macro and its `ac:macro-id`.
 * Placeholders that disappear are reported in `lostTokens` for the caller's
 * deletion gate; the engine never decides that a loss is acceptable.
 */

import {
  placeholderLiteralSurplus,
  TOKEN_LITERAL_PREFIX,
  tokeniseStorage,
} from "./tokeniser.js";
import { restoreFromTokens } from "./restore.js";
import { sanitiseTenantText } from "./untrusted-fence.js";
import {
  ConverterError,
  PLACEHOLDER_LITERAL_IN_PAGE,
  type TokenId,
  type TokenSidecar,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public types and error codes
// ---------------------------------------------------------------------------

/** One find/replace pair supplied by the caller. */
export interface FindReplacePair {
  /** Literal string to find (not a regex). */
  find: string;
  /** Replacement string (Confluence storage syntax; never converted). */
  replace: string;
  /** Replace every occurrence instead of requiring exactly one. */
  replace_all?: boolean;
}

/** How a pair matched: byte-for-byte, or after the view transform. */
export type FindReplaceMatchKind = "exact" | "normalised";

export interface FindReplacePairOutcome {
  matched: FindReplaceMatchKind;
  /** Occurrences replaced (1 unless `replace_all`). */
  count: number;
}

export interface FindReplaceOutcome {
  /** The section body with every pair applied and placeholders restored. */
  body: string;
  /** One entry per input pair, in order. */
  perPair: FindReplacePairOutcome[];
  /** Placeholders present before and absent after (macros being removed). */
  lostTokens: TokenId[];
  /** The sidecar of the original section body (for fingerprinting losses). */
  sidecar: TokenSidecar;
}

/** A find string does not occur (after tokenisation). */
export const FIND_REPLACE_MATCH_FAILED = "FIND_REPLACE_MATCH_FAILED";
/** A find string occurs more than once without `replace_all`. */
export const FIND_REPLACE_AMBIGUOUS = "FIND_REPLACE_AMBIGUOUS";
/** Malformed pair (empty find, oversized input). */
export const FIND_REPLACE_INVALID = "FIND_REPLACE_INVALID";
/** A placeholder would appear more than once in the result. */
export const DUPLICATED_TOKEN = "DUPLICATED_TOKEN";
/** Same code `restoreFromTokens` uses for unknown placeholder ids. */
export const FORGED_TOKEN = "FORGED_TOKEN";

/**
 * ConverterError whose message starts with its code. Tool errors surface
 * only the message, and the tool description names these codes, so the
 * agent must be able to see them.
 */
class FindReplaceError extends ConverterError {
  constructor(message: string, code: string) {
    super(`${code}: ${message}`, code);
  }
}

/** Upper bound on occurrences examined per pair (keeps counting linear-ish). */
export const MAX_FIND_OCCURRENCES = 10_000;

// ---------------------------------------------------------------------------
// View transform
// ---------------------------------------------------------------------------

// Memoised per code point. Both maps are bounded by the number of distinct
// code points ever seen, and mutated only here (caching a pure function).
const strippedCache = new Map<number, boolean>();
const pieceCache = new Map<number, string>();

/**
 * True when the fence deletes this (already NFKD-decomposed) code point.
 * Delegates to `sanitiseTenantText` so the strip set can never drift from
 * the fence's. NFKC never deletes a character, so an empty result means the
 * strip regex removed it.
 */
function isFenceStripped(cp: number): boolean {
  let hit = strippedCache.get(cp);
  if (hit === undefined) {
    hit = sanitiseTenantText(String.fromCodePoint(cp)) === "";
    strippedCache.set(cp, hit);
  }
  return hit;
}

/** V(c) for one code point: NFKD(c) minus the fence strip set. */
function viewPiece(cp: number): string {
  let piece = pieceCache.get(cp);
  if (piece === undefined) {
    piece = "";
    for (const d of String.fromCodePoint(cp).normalize("NFKD")) {
      if (!isFenceStripped(d.codePointAt(0)!)) piece += d;
    }
    pieceCache.set(cp, piece);
  }
  return piece;
}

/** V(s): the fence-equivalent view of a whole string. */
export function toFenceView(s: string): string {
  let out = "";
  for (const ch of s) out += viewPiece(ch.codePointAt(0)!);
  return out;
}

/**
 * Offset map between a string and its view. Code point k occupies
 * [srcStart[k], srcEnd[k]) in the source and [viewStart[k], viewEnd[k]) in
 * the view; stripped code points have an empty view range. Monotone in both
 * coordinates by construction.
 */
export interface ViewMap {
  view: string;
  srcStart: number[];
  srcEnd: number[];
  viewStart: number[];
  viewEnd: number[];
  /** First non-empty piece starting at view offset v (or -1). */
  pieceStartingAt: Int32Array;
  /** Last non-empty piece ending at view offset v (or -1). */
  pieceEndingAt: Int32Array;
}

export function buildViewMap(s: string): ViewMap {
  const srcStart: number[] = [];
  const srcEnd: number[] = [];
  const viewStart: number[] = [];
  const viewEnd: number[] = [];
  const pieces: string[] = [];
  let src = 0;
  let viewLen = 0;
  for (const ch of s) {
    const piece = viewPiece(ch.codePointAt(0)!);
    srcStart.push(src);
    src += ch.length;
    srcEnd.push(src);
    viewStart.push(viewLen);
    viewLen += piece.length;
    viewEnd.push(viewLen);
    pieces.push(piece);
  }
  const pieceStartingAt = new Int32Array(viewLen + 1).fill(-1);
  const pieceEndingAt = new Int32Array(viewLen + 1).fill(-1);
  for (let k = 0; k < pieces.length; k++) {
    if (pieces[k].length === 0) continue;
    if (pieceStartingAt[viewStart[k]] === -1) pieceStartingAt[viewStart[k]] = k;
    pieceEndingAt[viewEnd[k]] = k;
  }
  return {
    view: pieces.join(""),
    srcStart,
    srcEnd,
    viewStart,
    viewEnd,
    pieceStartingAt,
    pieceEndingAt,
  };
}

// ---------------------------------------------------------------------------
// Occurrence finding
// ---------------------------------------------------------------------------

/** A candidate match: source range plus, for view matches, view range. */
interface Occurrence {
  start: number;
  end: number;
  viewStart?: number;
  viewEnd?: number;
}

const PLACEHOLDER_RE = /\[\[epi:(T\d+)\]\]/g;

/**
 * For each source offset inside a placeholder, the placeholder's [start,end).
 * Used to reject matches that cut a placeholder in half.
 */
function placeholderSpans(s: string): { startOf: Int32Array; endOf: Int32Array } {
  const startOf = new Int32Array(s.length).fill(-1);
  const endOf = new Int32Array(s.length).fill(-1);
  for (const m of s.matchAll(PLACEHOLDER_RE)) {
    const a = m.index!;
    const b = a + m[0].length;
    startOf.fill(a, a, b);
    endOf.fill(b, a, b);
  }
  return { startOf, endOf };
}

function cutsPlaceholder(
  spans: { startOf: Int32Array; endOf: Int32Array },
  start: number,
  end: number,
): boolean {
  if (start < spans.startOf.length && spans.startOf[start] !== -1 && spans.startOf[start] !== start) {
    return true;
  }
  const last = end - 1;
  if (last >= 0 && last < spans.endOf.length && spans.endOf[last] !== -1 && spans.endOf[last] !== end) {
    return true;
  }
  return false;
}

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}
function splitsSurrogate(s: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < s.length &&
    isLow(s.charCodeAt(offset)) &&
    isHigh(s.charCodeAt(offset - 1))
  );
}

/**
 * All start offsets of `needle` in `hay`, overlapping. Throws once more
 * than MAX_FIND_OCCURRENCES raw hits are seen, before any filtering, so a
 * flood of invalid hits can never hide a second valid one past the cap.
 */
function allIndexes(hay: string, needle: string, label: string): number[] {
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    if (out.length === MAX_FIND_OCCURRENCES) {
      throw new FindReplaceError(
        `find_replace ${label} matches more than ${MAX_FIND_OCCURRENCES} ` +
          `times. Use a longer, more specific find string. No changes were made.`,
        FIND_REPLACE_AMBIGUOUS,
      );
    }
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

function exactOccurrences(
  working: string,
  find: string,
  spans: ReturnType<typeof placeholderSpans>,
  label: string,
): Occurrence[] {
  return allIndexes(working, find, label)
    .map((start) => ({ start, end: start + find.length }))
    .filter(
      (o) =>
        !splitsSurrogate(working, o.start) &&
        !splitsSurrogate(working, o.end) &&
        !cutsPlaceholder(spans, o.start, o.end),
    );
}

function viewOccurrences(
  map: ViewMap,
  viewFind: string,
  spans: ReturnType<typeof placeholderSpans>,
  label: string,
): Occurrence[] {
  const out: Occurrence[] = [];
  for (const vs of allIndexes(map.view, viewFind, label)) {
    const ve = vs + viewFind.length;
    const kStart = map.pieceStartingAt[vs];
    const kEnd = map.pieceEndingAt[ve];
    // Must begin and end on piece boundaries (no half of an NFKD expansion).
    if (kStart === -1 || kEnd === -1 || kEnd < kStart) continue;
    const start = map.srcStart[kStart];
    const end = map.srcEnd[kEnd];
    if (cutsPlaceholder(spans, start, end)) continue;
    out.push({ start, end, viewStart: vs, viewEnd: ve });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Byte-preserving splice for view matches
// ---------------------------------------------------------------------------

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function commonSuffix(a: string, b: string, limit: number): number {
  let i = 0;
  while (
    i < limit &&
    a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)
  ) {
    i++;
  }
  return i;
}

/** Is view offset v (absolute) a piece boundary in `map`? */
function isBoundary(map: ViewMap, v: number): boolean {
  return v === 0 || v === map.view.length || map.pieceStartingAt[v] !== -1;
}

/**
 * Source offset just before the first non-empty piece at view offset >= v:
 * stripped code points sitting at v go to the left side.
 */
function srcGreedy(map: ViewMap, v: number, fallback: number): number {
  for (let w = v; w < map.pieceStartingAt.length; w++) {
    const k = map.pieceStartingAt[w];
    if (k !== -1) return map.srcStart[k];
  }
  return fallback;
}

/**
 * Source offset just after the last non-empty piece ending at view offset
 * <= v: stripped code points sitting at v go to the right side.
 */
function srcLazy(map: ViewMap, v: number, fallback: number): number {
  for (let w = v; w >= 0; w--) {
    const k = map.pieceEndingAt[w];
    if (k !== -1) return map.srcEnd[k];
  }
  return fallback;
}

/**
 * Build the replacement for one view match. The common view prefix/suffix
 * of find and replace keep the stored bytes; the caller's bytes are used
 * only for the differing middle. Boundaries are snapped down until they are
 * piece boundaries on both the stored side and the replacement side.
 */
function preservingReplacement(
  working: string,
  workingMap: ViewMap,
  occ: Occurrence,
  replace: string,
  repMap: ViewMap,
): string {
  const vs = occ.viewStart!;
  const ve = occ.viewEnd!;
  const lenM = ve - vs;
  const stored = workingMap.view.slice(vs, ve);
  const lenR = repMap.view.length;

  let p = commonPrefix(stored, repMap.view);
  while (p > 0 && !(isBoundary(workingMap, vs + p) && isBoundary(repMap, p))) p--;
  let s = commonSuffix(stored, repMap.view, Math.min(lenM, lenR) - p);
  while (s > 0 && !(isBoundary(workingMap, ve - s) && isBoundary(repMap, lenR - s))) s--;

  // Clamped to the occurrence: stripped code points just outside it are
  // not part of the match and are emitted by the caller's slicing.
  const clamp = (x: number) => Math.min(occ.end, Math.max(occ.start, x));
  const keepPrefixEnd =
    p === 0 ? occ.start : clamp(srcGreedy(workingMap, vs + p, occ.end));
  const keepSuffixStart = Math.max(
    keepPrefixEnd,
    s === 0 ? occ.end : clamp(srcLazy(workingMap, ve - s, occ.start)),
  );
  // Caller's middle: stripped code points at either edge belong to the
  // discarded prefix/suffix of `replace`, not to the new text.
  const midStart = p === 0 ? 0 : srcGreedy(repMap, p, replace.length);
  const midEnd = s === 0 ? replace.length : srcLazy(repMap, lenR - s, 0);
  const middle = midStart < midEnd ? replace.slice(midStart, midEnd) : "";

  return (
    working.slice(occ.start, keepPrefixEnd) +
    middle +
    working.slice(keepSuffixStart, occ.end)
  );
}

// ---------------------------------------------------------------------------
// Placeholder validation
// ---------------------------------------------------------------------------

/**
 * Every `[[epi:` in `s` must begin a well-formed placeholder whose id the
 * sidecar knows. Anything else would either plant a literal in the page or
 * be expanded into a macro the caller has no right to reference.
 */
function assertOnlyKnownPlaceholders(
  s: string,
  sidecar: TokenSidecar,
  where: string,
): void {
  let i = s.indexOf(TOKEN_LITERAL_PREFIX);
  while (i !== -1) {
    const m = /^\[\[epi:(T\d+)\]\]/.exec(s.slice(i, i + 32));
    if (!m || !Object.prototype.hasOwnProperty.call(sidecar, m[1])) {
      throw new FindReplaceError(
        `find_replace ${where} contains a placeholder that is not part of ` +
          `this section (${JSON.stringify(m ? m[0] : s.slice(i, i + 16))}). ` +
          `Placeholders can only move or remove macros that already exist ` +
          `in the section; they cannot be invented.`,
        FORGED_TOKEN,
      );
    }
    i = s.indexOf(TOKEN_LITERAL_PREFIX, i + 1);
  }
}

function countPlaceholders(s: string): Map<TokenId, number> {
  const counts = new Map<TokenId, number>();
  for (const m of s.matchAll(PLACEHOLDER_RE)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function applyPair(
  working: string,
  pair: FindReplacePair,
  index: number,
): { next: string; outcome: FindReplacePairOutcome } {
  const { find, replace } = pair;
  const replaceAll = pair.replace_all === true;
  const spans = placeholderSpans(working);
  const shownFind = find.length > 200 ? `${find.slice(0, 200)}…` : find;
  const label = `pair ${index + 1} (find ${JSON.stringify(shownFind)})`;

  let matched: FindReplaceMatchKind = "exact";
  let workingMap: ViewMap | undefined;
  let occurrences = exactOccurrences(working, find, spans, label);
  if (occurrences.length === 0) {
    const viewFind = toFenceView(find);
    if (viewFind.length > 0) {
      workingMap = buildViewMap(working);
      occurrences = viewOccurrences(workingMap, viewFind, spans, label);
      matched = "normalised";
    }
  }

  if (occurrences.length === 0) {
    throw new FindReplaceError(
      `find_replace ${label} does not appear in the section body (after ` +
        `macro tokenisation and Unicode compatibility normalisation). No ` +
        `changes were made. Check that the find string matches text outside ` +
        `macro/attribute boundaries and does not cut a macro placeholder.`,
      FIND_REPLACE_MATCH_FAILED,
    );
  }
  if (!replaceAll && occurrences.length > 1) {
    throw new FindReplaceError(
      `find_replace ${label} matches ${occurrences.length} times (overlapping ` +
        `occurrences included); it must match exactly once. Extend the find ` +
        `string with surrounding text, or set replace_all: true on this pair ` +
        `to replace every occurrence. No changes were made.`,
      FIND_REPLACE_AMBIGUOUS,
    );
  }
  for (let i = 1; i < occurrences.length; i++) {
    if (occurrences[i].start < occurrences[i - 1].end) {
      throw new FindReplaceError(
        `find_replace ${label} has overlapping occurrences, so replace_all ` +
          `is ambiguous. Use a find string that cannot overlap itself. No ` +
          `changes were made.`,
        FIND_REPLACE_AMBIGUOUS,
      );
    }
  }

  const repMap = matched === "normalised" ? buildViewMap(replace) : undefined;
  const parts: string[] = [];
  let cursor = 0;
  for (const occ of occurrences) {
    parts.push(working.slice(cursor, occ.start));
    parts.push(
      matched === "exact"
        ? replace
        : preservingReplacement(working, workingMap!, occ, replace, repMap!),
    );
    cursor = occ.end;
  }
  parts.push(working.slice(cursor));
  return {
    next: parts.join(""),
    outcome: { matched, count: occurrences.length },
  };
}

/**
 * Apply `pairs` in order to a storage-format section body.
 *
 * @throws ConverterError — FIND_REPLACE_INVALID, FIND_REPLACE_MATCH_FAILED,
 *   FIND_REPLACE_AMBIGUOUS, PLACEHOLDER_LITERAL_IN_PAGE, FORGED_TOKEN,
 *   DUPLICATED_TOKEN. On any throw the caller must not write.
 */
export function applyFindReplace(
  sectionBody: string,
  pairs: readonly FindReplacePair[],
): FindReplaceOutcome {
  const { canonical, sidecar } = tokeniseStorage(sectionBody);

  if (placeholderLiteralSurplus(canonical, sidecar) > 0) {
    throw new FindReplaceError(
      "The section's text contains literal `[[epi:` " +
        "placeholder text outside any macro, so placeholders cannot be " +
        "restored unambiguously. Edit this section with a storage-format " +
        "body instead.",
      PLACEHOLDER_LITERAL_IN_PAGE,
    );
  }

  pairs.forEach((p, i) => {
    if (p.find.length === 0) {
      throw new FindReplaceError(
        `find_replace pair ${i + 1} has an empty find string.`,
        FIND_REPLACE_INVALID,
      );
    }
    assertOnlyKnownPlaceholders(p.replace, sidecar, `pair ${i + 1}'s replace`);
  });

  let working = canonical;
  const perPair: FindReplacePairOutcome[] = [];
  pairs.forEach((pair, i) => {
    const { next, outcome } = applyPair(working, pair, i);
    working = next;
    perPair.push(outcome);
  });

  // Text adjacent to a replacement can complete a placeholder the caller
  // never typed (e.g. replace "[[ep" next to "i:T0002]]"); re-check the
  // final form, which is what restore will actually see.
  assertOnlyKnownPlaceholders(working, sidecar, "result");

  const counts = countPlaceholders(working);
  const duplicated = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
  if (duplicated.length > 0) {
    throw new FindReplaceError(
      `The result would contain placeholder(s) ` +
        `${duplicated.join(", ")} more than once, which would duplicate the ` +
        `macro (including its ac:macro-id). Each placeholder may appear at ` +
        `most once. No changes were made.`,
      DUPLICATED_TOKEN,
    );
  }
  const lostTokens = Object.keys(sidecar).filter((id) => !counts.has(id));

  return {
    body: restoreFromTokens(working, sidecar),
    perPair,
    lostTokens,
    sidecar,
  };
}
