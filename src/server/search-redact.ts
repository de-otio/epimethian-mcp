/**
 * Text cleanup for `search_pages` titles and excerpts (S5).
 *
 * Two jobs:
 *
 *   1. Always strip the `@@@hl@@@` / `@@@endhl@@@` highlight markers the v1
 *      search endpoint wraps around matched terms.
 *   2. When the profile sets `redact_patterns`, replace each literal pattern
 *      with `[redacted]`.
 *
 * Redaction order (each step defeats a way of hiding a pattern from a plain
 * substring match):
 *
 *   1. strip highlight markers  (a marker can split a pattern: `sec@@@hl@@@ret`)
 *   2. decode HTML entities  (`se&#99;ret`, `&amp;#99;`)
 *   3. NFKC + the fence strip set + a few more invisible characters
 *      (fullwidth letters, zero-width / bidi / tag characters, soft hyphen)
 *   Steps 1-3 repeat until the text stops changing, because each can build
 *   the input of another (`&#64;` decodes to a marker character).
 *   4. match an ESCAPED-LITERAL RegExp with flags `giu`: no pattern is ever
 *      interpreted as a regex (no ReDoS), and `i` + `u` uses Unicode simple
 *      case folding, so there is no `toLowerCase` length drift to misalign
 *      offsets
 *   5. replace every match with `[redacted]`
 *
 * Patterns get the same normalisation as the text. Redaction is hygiene, not
 * a security boundary: it only sees what the search endpoint returns, and it
 * cannot hide that a result exists. Patterns must never appear in errors or
 * logs, so nothing here formats one.
 */

import { sanitiseTenantText } from "./converter/untrusted-fence.js";

export const REDACTED = "[redacted]";

/** Applies the full redaction pipeline to already-marker-stripped text. */
export type Redactor = (text: string) => string;

const HIGHLIGHT_MARKER_RE = /@@@(?:end)?hl@@@/g;

/**
 * Remove highlight markers. Repeats until stable so a marker nested inside
 * another (`@@@h@@@hl@@@l@@@`) cannot reassemble after one pass; every pass
 * shortens the string, so this terminates.
 */
export function stripHighlightMarkers(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(HIGHLIGHT_MARKER_RE, "");
    if (next === out) return out;
    out = next;
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0",
  shy: "\u00AD", zwnj: "\u200C", zwj: "\u200D", lrm: "\u200E", rlm: "\u200F",
  uuml: "ü", auml: "ä", ouml: "ö", szlig: "ß", Uuml: "Ü", Auml: "Ä", Ouml: "Ö",
  eacute: "é", egrave: "è", agrave: "à", ecirc: "ê", ccedil: "ç", ocirc: "ô",
  icirc: "î", ucirc: "û", Eacute: "É",
  mdash: "—", ndash: "–", laquo: "«", raquo: "»", hellip: "…",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  euro: "€", copy: "©", reg: "®", trade: "™",
};

const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

function decodeCodePoint(n: number): string {
  // Out-of-range, surrogate and NUL references decode to U+FFFD, as browsers do.
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
    return "\uFFFD";
  }
  return String.fromCodePoint(n);
}

/**
 * Decode numeric and common named entities in one pass. Unknown named
 * entities are left as written.
 */
export function decodeEntitiesOnce(text: string): string {
  return text.replace(ENTITY_RE, (full, ref: string) => {
    if (ref[0] === "#") {
      const hex = ref[1] === "x" || ref[1] === "X";
      return decodeCodePoint(parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return NAMED_ENTITIES[ref] ?? full;
  });
}

// Invisible characters the fence strip set does not cover but that split a
// word without changing how it reads: soft hyphen, combining grapheme joiner,
// Arabic letter mark, Mongolian free variation selectors and vowel separator,
// variation selectors, BOM / zero-width no-break space.
const EXTRA_INVISIBLE_RE = /[\u00AD\u034F\u061C\u180B-\u180E\uFE00-\uFE0F\uFEFF]/gu;

/** NFKC + fence strip set + extra invisibles, with a final NFKC for re-composition. */
function normaliseForMatch(text: string): string {
  return sanitiseTenantText(text).replace(EXTRA_INVISIBLE_RE, "").normalize("NFKC");
}

const MAX_CANONICAL_PASSES = 16;

/**
 * Bring text to the form patterns are matched against: strip highlight
 * markers, decode entities, normalise. Each step can create the input of
 * another (`&#64;` decodes to a marker character, a fullwidth at-sign normalises to
 * one, `&amp;#99;` decodes to another entity), so the sequence repeats until
 * the text stops changing. Returns undefined if it has not settled after
 * MAX_CANONICAL_PASSES, which only adversarial nesting does.
 */
function canonicalise(text: string): string | undefined {
  let out = text;
  for (let pass = 0; pass < MAX_CANONICAL_PASSES; pass++) {
    const next = normaliseForMatch(stripHighlightMarkers(decodeEntitiesOnce(out)));
    if (next === out) return out;
    out = next;
  }
  return undefined;
}

// `-` is deliberately not escaped: `\-` is an invalid identity escape under the `u` flag.
const REGEXP_SYNTAX_RE = /[\\^$.*+?()[\]{}|/]/g;
const escapeRegExp = (s: string): string => s.replace(REGEXP_SYNTAX_RE, "\\$&");

/**
 * Normalise a configured pattern the same way text is normalised. Returns
 * undefined when nothing is left (a pattern made only of invisible characters
 * would otherwise compile to an empty alternative that matches everywhere).
 */
export function normaliseRedactPattern(pattern: string): string | undefined {
  const normalised = normaliseForMatch(pattern);
  return normalised === "" ? undefined : normalised;
}

/**
 * Compile literal patterns into a Redactor. Returns undefined when there is
 * nothing to redact. Throws if a pattern normalises to nothing; callers
 * validate with `normaliseRedactPattern` first so the message stays free of
 * the pattern text.
 */
export function compileRedactor(patterns: readonly string[]): Redactor | undefined {
  if (patterns.length === 0) return undefined;
  const literals = patterns.map((p) => {
    const n = normaliseRedactPattern(p);
    if (n === undefined) throw new Error("redact pattern is empty after normalisation");
    return n;
  });
  // Longest first so a pattern that contains another is redacted as a whole.
  const alternation = [...new Set(literals)]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const re = new RegExp(alternation, "giu");
  return (text) => {
    const canonical = canonicalise(text);
    // Text that never settles is hiding something; show none of it.
    return canonical === undefined ? REDACTED : canonical.replace(re, REDACTED);
  };
}

/**
 * Clean one search title or excerpt: always strip highlight markers, redact
 * when a redactor is configured, then reduce the text to a single line.
 *
 * Every whitespace run (newlines, tabs, line and paragraph separators, NBSP
 * and the like) becomes one space, so the text can never start a new line
 * that looks like a result field (`ID: ...`, `Title: ...`) to the reader.
 * The tenant-text sanitiser runs first because its NFKC step can turn
 * compatibility characters into whitespace.
 */
export function cleanSearchText(text: string, redactor?: Redactor): string {
  const stripped = stripHighlightMarkers(text);
  const redacted = redactor === undefined ? stripped : redactor(stripped);
  return sanitiseTenantText(redacted).replace(/\s+/gu, " ").trim();
}

const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9_.~:/-]{1,64}$/; // `/` admits the literal `N/A`

/**
 * Render a server-assigned identifier (page id, space id or key) that is
 * printed outside a fence. Real values are short and use a narrow alphabet;
 * anything else is shown as `unknown` rather than passed through.
 */
export function safeIdentifier(value: string): string {
  return SAFE_IDENTIFIER_RE.test(value) ? value : "unknown";
}
