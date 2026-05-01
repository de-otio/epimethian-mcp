/**
 * Atlassian account ID format validation.
 *
 * SECURITY: account IDs flow into ri:account-id XML attributes. An
 * unvalidated value can break out of the attribute and inject XML. See
 * doc/design/investigations/investigate-confluence-specific-elements/06-security.md #6.
 */

/**
 * Hard upper bound on account-ID length. Atlassian's longest observed
 * format is the modern `557058:<uuid>` form at 43 characters; we allow
 * comfortably above that to stay forward-compatible but well under any
 * pathological-input threshold.
 */
const MAX_LEN = 200;

/**
 * Modern Atlassian Cloud account ID: a numeric prefix followed by `:`
 * and an opaque identifier. In practice the prefix is 6 digits and the
 * suffix is a UUID (36 chars with hyphens), but we keep the suffix loose
 * to accommodate formats Atlassian has documented but not all examples
 * use (e.g. UUIDs without hyphens).
 *
 * Suffix charset is strict hex+hyphen — consistent with every modern
 * account ID observed in the field and, critically, contains no XML
 * specials or control characters.
 */
const MODERN_RE = /^[0-9]+:[0-9a-fA-F-]{16,}$/;

/**
 * Legacy Atlassian account ID: opaque 24-char hex string (pre-Cloud
 * GDPR migration), documented to start with `5b`, `5c`, `5d`, `5e`, or
 * `5f` in the long-published Atlassian examples. We accept any 24-char
 * hex value beginning with `5` to stay permissive without opening the
 * charset up.
 */
const LEGACY_RE = /^5[0-9a-fA-F]{23}$/;

/**
 * Returns true if the given string matches a known Atlassian account-ID
 * format. Modern Cloud format is "557058:UUID"; older accounts use
 * opaque "5..." hex IDs of bounded length.
 *
 * The regexes are intentionally strict — any character outside the
 * hex/colon/digit/hyphen set is rejected, which on its own neutralises
 * XML-attribute injection attempts (quote, angle brackets, ampersand,
 * apostrophe, control characters, null bytes).
 */
export function isValidAccountId(id: string): boolean {
  if (typeof id !== "string") return false;
  if (id.length === 0) return false;
  if (id.length > MAX_LEN) return false;
  return MODERN_RE.test(id) || LEGACY_RE.test(id);
}
