/**
 * Track D2: injection-signal scanner for fenced tenant content.
 *
 * When a page body, comment, version note, or other tenant-authored string
 * contains patterns known to occur in prompt-injection payloads (tool
 * names, destructive flag names, instruction-style framing, fence-marker
 * references), we annotate the enclosing fence with
 * `injection-signals=<comma-list>` so the model has a second, more specific
 * cue beyond the fence itself. Signals also fire to stderr + (when a
 * subsequent write happens) to the mutation log.
 *
 * Matching is regex-based and intentionally conservative:
 *
 *   - Whole-word matches where possible to avoid firing on substrings
 *     inside natural prose (e.g. "update_page" as a token vs. "update
 *     page" as English).
 *   - Case-insensitive for instruction framing (attackers vary
 *     capitalisation).
 *   - False positives are acceptable — the annotation is advisory, never
 *     rejecting. False negatives are the bigger concern.
 *
 * Runs AFTER `sanitiseTenantText` (Track D1) so Unicode obfuscation can't
 * hide signals from the scanner. Spec: see
 * `doc/design/investigations/investigate-prompt-injection-hardening/05-content-signal-scanning.md`.
 */

/** Classes of signal the scanner can fire. Ordered roughly by strength. */
export type InjectionSignal =
  | "named-tool"
  | "destructive-flag-name"
  | "instruction-frame"
  | "fence-string-reference";

/**
 * Epimethian tool names. Presence inside fenced content is a signal that
 * the content is talking about this server's tools — likely intended to
 * steer the agent's subsequent calls.
 */
const TOOL_NAMES = [
  "create_page",
  "update_page",
  "update_page_section",
  "delete_page",
  "prepend_to_page",
  "append_to_page",
  "revert_page",
  "add_attachment",
  "add_drawio_diagram",
  "create_comment",
  "delete_comment",
  "resolve_comment",
  "set_page_status",
  "remove_page_status",
  "add_label",
  "remove_label",
];

/**
 * Destructive flag names. These are Epimethian-specific strings; their
 * presence in tenant content is almost always an attempt to steer the
 * agent into setting the flag.
 */
const DESTRUCTIVE_FLAG_NAMES = [
  "confirm_shrinkage",
  "confirm_structure_loss",
  "confirm_deletions",
  "replace_body",
];

/**
 * Instruction-style framing. Case-insensitive, line- or start-anchored
 * where appropriate.
 */
const INSTRUCTION_FRAMES: RegExp[] = [
  /\bIGNORE\s+(ABOVE|PREVIOUS|PRIOR)\b/i,
  /\bDISREGARD\s+(PRIOR|PREVIOUS|ABOVE)\b/i,
  /\bNEW\s+INSTRUCTIONS\b/i,
  /\bYOUR?\s+NEW\s+TASK\s+IS\b/i,
  /\bSYSTEM\s*:/i,
  /\bASSISTANT\s*:/i,
  /<\|im_start\|>/,
  /<\/?system>/i,
  /\[\[system\]\]/i,
  /<instructions>/i,
];

/** Escape a literal string for safe inclusion in a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pre-compiled word-boundary regex for each tool and flag name. Compiled
// once at module load so scanning hot paths don't re-build them per call.
const TOOL_NAME_RE = new RegExp(
  `\\b(?:${TOOL_NAMES.map(escapeRegExp).join("|")})\\b`,
);
const DESTRUCTIVE_FLAG_RE = new RegExp(
  `\\b(?:${DESTRUCTIVE_FLAG_NAMES.map(escapeRegExp).join("|")})\\b`,
);
const FENCE_STRING_RE = /\b(CONFLUENCE_UNTRUSTED|END_CONFLUENCE_UNTRUSTED)\b/;

/**
 * Scan `content` for injection signals. Returns the distinct signal
 * classes that fired — an empty array if none did.
 *
 * Deterministic ordering so the fence attribute is stable across reads
 * of the same content (useful for test assertions and log-comparison).
 */
export function scanInjectionSignals(content: string): InjectionSignal[] {
  const found: InjectionSignal[] = [];
  if (TOOL_NAME_RE.test(content)) found.push("named-tool");
  if (DESTRUCTIVE_FLAG_RE.test(content)) found.push("destructive-flag-name");
  if (INSTRUCTION_FRAMES.some((re) => re.test(content))) {
    found.push("instruction-frame");
  }
  if (FENCE_STRING_RE.test(content)) found.push("fence-string-reference");
  return found;
}

/**
 * Format the signal list for the fence `injection-signals=` attribute.
 * Returns `undefined` when the list is empty so callers can skip emitting
 * the attribute entirely.
 */
export function formatSignalsAttribute(
  signals: InjectionSignal[],
): string | undefined {
  if (signals.length === 0) return undefined;
  return signals.join(",");
}
