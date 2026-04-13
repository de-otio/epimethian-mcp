/**
 * Token→storage restorer.
 *
 * Replaces every `[[epi:T####]]` token in a string with the verbatim
 * XML recorded in the sidecar map. The replacement is a byte-for-byte
 * substitution — nothing is re-derived, normalised, or re-escaped.
 *
 * Security: the sidecar passed to this function is the *only* trusted
 * token table for the current (page, version) scope. Any token ID that
 * appears in the input but is not present in the sidecar is treated as
 * caller forgery and rejected with `ConverterError("…", "FORGED_TOKEN")`
 * — see
 * doc/design/investigations/investigate-confluence-specific-elements/
 * 06-security.md § #8. Sidecar entries that do not appear in the input
 * are silently ignored (they represent explicit deletions; Stream 4
 * handles diff logging).
 */

import { ConverterError } from "./types.js";
import type { TokenSidecar } from "./types.js";

/**
 * Matches a single token of the form `[[epi:T<digits>]]`. The token
 * format is defined in tokeniser.ts; see the module header there for
 * why this form was chosen over `<!--epi:T####-->`.
 */
const TOKEN_RE = /\[\[epi:(T\d+)\]\]/g;

/**
 * Restore every token in `storageWithTokens` from the sidecar map.
 *
 * @param storageWithTokens text (typically tokenised storage or
 *   rendered markdown) that contains `[[epi:T####]]` tokens.
 * @param sidecar token-id → verbatim-outer-XML map produced by a prior
 *   call to `tokeniseStorage` on the same page+version.
 * @returns the input with every token replaced by its sidecar entry,
 *   byte-for-byte.
 * @throws ConverterError with code `"FORGED_TOKEN"` if the input
 *   contains a token ID that is not present in the sidecar.
 */
export function restoreFromTokens(
  storageWithTokens: string,
  sidecar: TokenSidecar
): string {
  // Fast path: nothing to restore.
  if (storageWithTokens.length === 0) return "";

  return storageWithTokens.replace(TOKEN_RE, (_match, id: string) => {
    // `Object.prototype.hasOwnProperty` guards against prototype-chain
    // collisions (e.g. a token literally named "T__proto__" would
    // otherwise match Object.prototype). In practice the token format
    // is `T\d+` so the guard is defence in depth.
    if (!Object.prototype.hasOwnProperty.call(sidecar, id)) {
      throw new ConverterError(
        `forged or unknown token ${id}`,
        "FORGED_TOKEN"
      );
    }
    return sidecar[id]!;
  });
}
