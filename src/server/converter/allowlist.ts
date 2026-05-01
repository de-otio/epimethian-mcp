/**
 * Allowlist of macro names permitted via raw <ac:.../> passthrough.
 *
 * SECURITY: this allowlist exists as a constant in source — runtime
 * configuration would let an attacker who controls config widen the
 * attack surface. See investigation 06-security.md #2.
 */

/**
 * The set of macro names that may appear inline as raw
 * `<ac:structured-macro ac:name="...">` in markdown bodies. Any other
 * macro name in raw form is rejected with a clear error pointing at the
 * supported markdown syntax.
 *
 * Kept in sync with
 * doc/design/investigations/investigate-confluence-specific-elements/04-markdown-syntax-design.md
 * § "Channel 4 — allowlisted raw storage-format escape hatch".
 */
export const MACRO_ALLOWLIST: readonly string[] = Object.freeze([
  "info",
  "note",
  "warning",
  "tip",
  "success",
  "panel",
  "code",
  "expand",
  "toc",
  "status",
  "anchor",
  "excerpt",
  "excerpt-include",
  "drawio",
  "children",
  "jira",
]);

/**
 * O(1) lookup table. Using a Set keeps the check case-sensitive, constant
 * time, and immune to prototype-pollution tricks that can occasionally
 * affect plain object lookups.
 */
const ALLOWED = new Set<string>(MACRO_ALLOWLIST);

/**
 * Returns true if the given macro name is on the allowlist.
 *
 * Match is strict:
 * - case-sensitive (`Info` ≠ `info`),
 * - literal (`info ` with trailing space rejects),
 * - no normalisation (whitespace, punctuation, control chars all reject),
 * - defensive against non-string inputs.
 */
export function isMacroAllowed(name: string): boolean {
  if (typeof name !== "string") return false;
  return ALLOWED.has(name);
}
