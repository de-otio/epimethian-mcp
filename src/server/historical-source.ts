/**
 * Which API serves a historical page body (W-HIST, plan section 5.2).
 *
 * Pure: no I/O. Kept apart from `confluence-client.ts` so handlers can pick a
 * source without importing the client (hand-written client mocks in handler
 * tests stay valid).
 */

export type HistoricalSource = "v1" | "v2";

/**
 * The source `revert_page` reads the target version from in SITE mode.
 *
 * It stays "v1" until the live parity probe shows v2 returns byte-identical
 * historical bodies (plan section 5.1 step 2: 30 of 30 versions, see
 * doc/design/investigations/investigate-v1-v2-parity-2026-11.md). A revert
 * writes the body it read, so a body that differs from v1 by even one byte is
 * a data-integrity change, not a read difference.
 *
 * FLIPPING IT: when the probe shows parity, change this constant to "v2".
 * That is the whole change; the version assertion, the cache keying and the
 * tests already cover both values.
 */
export const REVERT_HISTORICAL_SOURCE_SITE: HistoricalSource = "v1";

/**
 * The historical source for `revert_page`. In gateway mode (`apiV1 === null`)
 * v1 does not exist, so v2 is the only choice and its fail-closed version
 * assertion is what protects the revert.
 */
export function revertHistoricalSource(cfg: { readonly apiV1: string | null }): HistoricalSource {
  return cfg.apiV1 === null ? "v2" : REVERT_HISTORICAL_SOURCE_SITE;
}
