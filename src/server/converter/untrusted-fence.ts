/**
 * Untrusted-content fence helper (Track B2 of `plans/security-audit-fixes.md`).
 * Spec: `plans/untrusted-content-fence-spec.md`.
 *
 * Wraps tenant-authored Confluence content in visibly-delimited fences so the
 * LLM receiving the content can distinguish it from instructions it should
 * act on. The fences are paired with tool-description paragraphs (see B3) that
 * instruct the model to treat fenced content as data.
 *
 * This is a **behavioural** defence, not a cryptographic one. An agent that
 * ignores its tool-description instructions can still be hijacked by fenced
 * content. The fence exists to make the data / instruction boundary visible.
 */

/** Opening fence prefix. Full fence: `<<<CONFLUENCE_UNTRUSTED key=value...>>>`. */
export const OPEN_FENCE_PREFIX = "<<<CONFLUENCE_UNTRUSTED";

/** Closing fence (fixed, no attributes). */
export const CLOSE_FENCE = "<<<END_CONFLUENCE_UNTRUSTED>>>";

/**
 * Defined attribute keys and their accepted `field` values. Values outside the
 * ASCII alphanumeric + `_.-` subset fall back to `unknown` before rendering.
 */
export type FenceField =
  | "body"
  | "title"
  | "excerpt"
  | "comment"
  | "label"
  | "displayName"
  | "section"
  | "headings"
  | "markdown"
  | "diff"
  | "versionNote"
  | "statusName";

export interface FenceAttrs {
  pageId?: string | number;
  field: FenceField;
  version?: string | number;
  commentId?: string | number;
  sectionIndex?: string | number;
}

import { getSessionCanary } from "../session-canary.js";
import {
  formatSignalsAttribute,
  scanInjectionSignals,
  type InjectionSignal,
} from "./injection-signals.js";

const SAFE_ATTR_VALUE_RE = /^[A-Za-z0-9_.-]+$/;

function sanitiseAttrValue(raw: string | number | undefined): string {
  if (raw === undefined || raw === null) return "unknown";
  const s = String(raw);
  if (s.length === 0) return "unknown";
  return SAFE_ATTR_VALUE_RE.test(s) ? s : "unknown";
}

function renderAttrs(attrs: FenceAttrs): string {
  const parts: string[] = [];
  if (attrs.pageId !== undefined) parts.push(`pageId=${sanitiseAttrValue(attrs.pageId)}`);
  parts.push(`field=${attrs.field}`);
  if (attrs.version !== undefined) parts.push(`version=${sanitiseAttrValue(attrs.version)}`);
  if (attrs.commentId !== undefined) parts.push(`commentId=${sanitiseAttrValue(attrs.commentId)}`);
  if (attrs.sectionIndex !== undefined) parts.push(`sectionIndex=${sanitiseAttrValue(attrs.sectionIndex)}`);
  return parts.join(" ");
}

/**
 * Escape any embedded fence markers so an attacker cannot close the fence from
 * inside. Doubles the leading `<` to `<<<<` for either fence prefix — the
 * result is no longer a valid fence, regardless of syntax. Idempotent once per
 * wrap; callers must NOT double-apply.
 *
 * Spec §2: escape rule.
 */
export function escapeFenceContent(content: string): string {
  // Replace the close fence first to avoid cascading rewrites if the open
  // prefix appears inside an attempt to close. Both replacements are
  // plain-string, not regex, so special characters in other positions are
  // untouched.
  const withCloseEscaped = content.split(CLOSE_FENCE).join(`<${CLOSE_FENCE}`);
  const withOpenEscaped = withCloseEscaped
    .split(OPEN_FENCE_PREFIX)
    .join(`<${OPEN_FENCE_PREFIX}`);
  return withOpenEscaped;
}

/**
 * Track D1: pre-escape Unicode sanitisation.
 *
 * Strips character classes that enable fence-spoofing or instruction
 * steganography inside tenant-authored content:
 *
 *   - NFKC normalisation: folds fullwidth brackets (`＜` U+FF1C) back to
 *     ASCII `<`, so a fullwidth-bracket close fence gets caught by
 *     `escapeFenceContent` afterward.
 *   - Unicode tag characters (U+E0000–U+E007F): invisible in most fonts;
 *     used to hide instruction payloads from human reviewers while
 *     remaining readable by the model.
 *   - Bidi controls (U+202A–U+202E, U+2066–U+2069): reverse visual
 *     order; used to make fences look different to humans vs. the model.
 *   - Zero-width joiners (U+200B–U+200D, U+2060): split tokens in ways
 *     that bypass naïve string scans while reading identically.
 *   - C0 controls (U+0000–U+001F) except `\n` (U+000A), `\t` (U+0009),
 *     and `\r` (U+000D): includes ESC (U+001B) which introduces ANSI
 *     escape sequences. Newlines, tabs, and carriage returns are
 *     preserved per spec §6.4.
 *   - DEL (U+007F) and C1 controls (U+0080–U+009F): terminal control
 *     extensions, rarely legitimate in textual content.
 *
 * Exported for tests; applied inside `fenceUntrusted` before
 * `escapeFenceContent` so the escape step sees normalised characters.
 */
export function sanitiseTenantText(content: string): string {
  // Build the strip regex from explicit hex escapes to avoid any encoding
  // ambiguity at this file's source level. Ranges chosen to preserve
  // \t (0x09), \n (0x0A), and \r (0x0D).
  const C0 = "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F";
  const DEL_C1 = "\\u007F-\\u009F";
  const ZEROWIDTH = "\\u200B-\\u200D\\u2060";
  const BIDI = "\\u202A-\\u202E\\u2066-\\u2069";
  const TAG_CHARS = "\\u{E0000}-\\u{E007F}";
  const strip = new RegExp(
    `[${C0}${DEL_C1}${ZEROWIDTH}${BIDI}${TAG_CHARS}]`,
    "gu",
  );
  return content.normalize("NFKC").replace(strip, "");
}

/**
 * Wrap tenant-controlled content in an untrusted-content fence. Empty content
 * still emits the fence (uniform format; makes B4 regression tests assertable).
 *
 * Example output:
 * ```
 * <<<CONFLUENCE_UNTRUSTED pageId=123 field=body>>>
 * …content…
 * <!-- canary:EPI-… -->
 * <<<END_CONFLUENCE_UNTRUSTED>>>
 * ```
 *
 * Track D3: the `<!-- canary:… -->` trailer carries a per-session random
 * string. `safePrepareBody` rejects any write whose `body` contains the
 * canary — catching agents that copy a read response verbatim into an
 * update/create, which would propagate any injection payload.
 */
export function fenceUntrusted(content: string, attrs: FenceAttrs): string {
  const sanitised = sanitiseTenantText(content);
  // Track D2: scan BEFORE escaping so the signal detector sees the content
  // as the agent will see it post-sanitisation (but before fence-marker
  // doubling obscures the fence-string-reference signal).
  const signals = scanInjectionSignals(sanitised);
  const escaped = escapeFenceContent(sanitised);
  let headerAttrs = renderAttrs(attrs);
  const signalAttr = formatSignalsAttribute(signals);
  if (signalAttr !== undefined) {
    headerAttrs = `${headerAttrs} injection-signals=${signalAttr}`;
    // D2: emit a single stderr breadcrumb per fired signal set so the
    // operator has a realtime cue even without the mutation log enabled.
    // Format is metadata-only — no body content, just the page/field
    // attribution and the signal list.
    try {
      const attrField = `field=${attrs.field}`;
      const attrPage = attrs.pageId !== undefined ? ` pageId=${attrs.pageId}` : "";
      console.error(
        `epimethian-mcp: [INJECTION-SIGNAL]${attrPage} ${attrField} signals=${signalAttr}`,
      );
    } catch {
      // stderr best-effort — do not propagate.
    }
    // Record on the preceding-signals tracker so a subsequent write can
    // surface what the agent recently read that looked suspect.
    recentSignalsTracker.push(signals);
  }
  const header = `${OPEN_FENCE_PREFIX} ${headerAttrs}>>>`;
  // Ensure the closing fence starts on its own line even when content does
  // not end with a newline.
  const trailer = escaped.endsWith("\n") ? "" : "\n";
  const canaryLine = `<!-- canary:${getSessionCanary()} -->\n`;
  return `${header}\n${escaped}${trailer}${canaryLine}${CLOSE_FENCE}`;
}

// ---------------------------------------------------------------------------
// Preceding-signals tracker
// ---------------------------------------------------------------------------

/**
 * In-memory ring of signals fired by fenceUntrusted in the last N seconds.
 * `safeSubmitPage` reads from this tracker when recording a mutation so a
 * forensic audit can correlate "the agent read a suspect page" with
 * "the agent then attempted a write". Process-scoped; clears on restart.
 *
 * Design note: this is INTENTIONALLY coarse. We don't try to attribute
 * each signal to a specific tool-call turn; we just record what fired
 * recently. Fine-grained correlation would require MCP-level session
 * plumbing we do not have.
 */
const RECENT_SIGNAL_TTL_MS = 60_000;
class RecentSignalsTracker {
  private entries: { at: number; signals: InjectionSignal[] }[] = [];

  push(signals: InjectionSignal[]): void {
    if (signals.length === 0) return;
    this.entries.push({ at: Date.now(), signals });
  }

  /**
   * Return the union of signal classes that fired within the last
   * RECENT_SIGNAL_TTL_MS. Expires old entries as a side effect.
   */
  recent(): InjectionSignal[] {
    const cutoff = Date.now() - RECENT_SIGNAL_TTL_MS;
    this.entries = this.entries.filter((e) => e.at >= cutoff);
    const set = new Set<InjectionSignal>();
    for (const e of this.entries) for (const s of e.signals) set.add(s);
    return Array.from(set).sort();
  }

  /** Testing-only. */
  _resetForTest(): void {
    this.entries = [];
  }
}

export const recentSignalsTracker = new RecentSignalsTracker();
