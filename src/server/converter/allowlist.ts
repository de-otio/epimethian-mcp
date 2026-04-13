/**
 * Allowlist of macro names permitted via raw <ac:.../> passthrough.
 *
 * SECURITY: this allowlist exists as a constant in source — runtime
 * configuration would let an attacker who controls config widen the
 * attack surface. See investigation 06-security.md #2.
 *
 * Stream 0: stub. Stream 1 implements (constant + check function).
 */

/**
 * The set of macro names that may appear inline as raw <ac:structured-macro
 * ac:name="..."> in markdown bodies. Any other macro name in raw form
 * is rejected with a clear error pointing at the supported markdown
 * syntax.
 */
export const MACRO_ALLOWLIST: readonly string[] = [];

/**
 * Returns true if the given macro name is on the allowlist. Case-sensitive.
 */
export function isMacroAllowed(_name: string): boolean {
  throw new Error("isMacroAllowed: not implemented (Stream 1)");
}
