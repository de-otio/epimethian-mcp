/**
 * Attachment filename validation for Confluence ri:attachment refs.
 *
 * SECURITY: filenames flow into ri:filename XML attributes. Reject
 * path-traversal, control characters, and otherwise unsafe inputs. See
 * doc/design/investigations/investigate-confluence-specific-elements/06-security.md #7.
 */

/** POSIX + Windows filesystem limit. */
const MAX_LEN = 255;

/**
 * Returns true if the filename is safe to emit into an `ri:filename`
 * attribute.
 *
 * Rejection rules (any one triggers rejection):
 * - empty string.
 * - >255 bytes (UTF-16 code units).
 * - contains `/` or `\` (directory separator on either platform).
 * - contains a null byte or any other C0/C1 control character.
 * - equals `..` or starts with a leading dot (hidden files; also catches
 *   the `..` path-traversal idiom in a stricter form).
 * - contains `..` as a path segment (safety net if the caller concatenated
 *   an already-escaped path-traversal sequence — e.g. `foo/../bar` is
 *   rejected by the slash check, but `..` alone is rejected here).
 *
 * We do NOT attempt to percent-decode the filename — that is the caller's
 * responsibility if they have a URL-encoded filename. A percent-encoded
 * traversal like `..%2F..%2F` will be accepted as a literal filename
 * (which is safe: the attribute escape layer neutralises the `%` and
 * Confluence will store the literal filename with percent signs). The
 * "percent-encoded path traversal" threat applies when an upstream layer
 * decodes the value before passing it in; callers that do that must
 * validate post-decode, which is exactly what this helper does.
 */
export function isValidAttachmentFilename(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0) return false;
  if (name.length > MAX_LEN) return false;

  // Leading-dot files (hidden files, and `..` as a whole).
  if (name.startsWith(".")) return false;

  for (let i = 0; i < name.length; i++) {
    const ch = name.charCodeAt(i);
    // Null byte and all C0 / C1 control chars.
    if ((ch >= 0x00 && ch <= 0x1f) || (ch >= 0x7f && ch <= 0x9f)) return false;
    // Directory separators.
    if (ch === 0x2f /* / */ || ch === 0x5c /* \ */) return false;
  }

  return true;
}
