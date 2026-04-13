/**
 * Token→storage restorer.
 *
 * Replaces every <!--epi:T####--> token in a string with the verbatim
 * XML stored in the sidecar map. Tokens not in the sidecar are caller
 * forgery and must throw ConverterError.
 *
 * Stream 0: stub. Stream 3 implements.
 */

import type { TokenSidecar } from "./types.js";

/**
 * Restore tokens to their original storage XML byte-for-byte.
 *
 * @param storageWithTokens storage XML containing <!--epi:T####--> tokens
 * @param sidecar token-id → outer-XML map from a prior tokenisation
 * @throws ConverterError if storageWithTokens contains a token not in sidecar
 */
export function restoreFromTokens(
  _storageWithTokens: string,
  _sidecar: TokenSidecar
): string {
  throw new Error("restoreFromTokens: not implemented (Stream 3)");
}
