/**
 * Atlassian account ID format validation.
 *
 * SECURITY: account IDs flow into ri:account-id XML attributes. An
 * unvalidated value can break out of the attribute and inject XML.
 *
 * Stream 0: stub. Stream 1 implements.
 */

/**
 * Returns true if the given string matches a known Atlassian account-ID
 * format. Modern Cloud format is "557058:UUID"; older accounts use
 * opaque "5b…" IDs of bounded length.
 */
export function isValidAccountId(_id: string): boolean {
  throw new Error("isValidAccountId: not implemented (Stream 1)");
}
