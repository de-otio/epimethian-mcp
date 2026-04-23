/**
 * Per-session canary for round-trip echo detection (Track D3).
 *
 * At server startup, generate a random string and embed it inside every
 * untrusted-content fence. If a write-path handler receives a body that
 * contains the canary (or the fence markers themselves), the agent has
 * almost certainly just copied a read response back into a write — which
 * would propagate any injection payload attached to the original read.
 * Such writes are rejected with `WRITE_CONTAINS_UNTRUSTED_FENCE`.
 *
 * Design decisions:
 *   - Session-scoped. Regenerated per-process; never persisted. A
 *     compromised session cannot smuggle the canary forward past a
 *     restart.
 *   - Random-per-session so content captured in one session's read
 *     does not match another session's canary (reduces collision risk
 *     when sessions share attackers).
 *   - Short prefix (`EPI-`) for grep-friendliness in forensics.
 */

import { randomUUID } from "node:crypto";

let _canary: string | undefined;

/**
 * Return the current session canary, generating one on first access.
 * Idempotent: subsequent calls return the same value.
 */
export function getSessionCanary(): string {
  if (_canary === undefined) {
    _canary = `EPI-${randomUUID()}`;
  }
  return _canary;
}

/**
 * Reset the canary. **Testing only** — production startup generates the
 * canary once on first `getSessionCanary()` call and never rotates.
 */
export function _resetSessionCanaryForTest(): void {
  _canary = undefined;
}

/**
 * Check whether a body contains artefacts that indicate it was copied from
 * a previous read-tool response (which would be fenced content). Returns
 * the specific marker found, or `undefined` if the body is clean.
 *
 * Checks, in order:
 *   1. The opening fence prefix `<<<CONFLUENCE_UNTRUSTED`.
 *   2. The closing fence string `<<<END_CONFLUENCE_UNTRUSTED>>>`.
 *   3. The current session's canary.
 *
 * Any match means the caller echoed back tool output. The write is
 * rejected so any injection payload that rode along gets caught here.
 */
export function detectUntrustedFenceInWrite(body: string): string | undefined {
  if (body.includes("<<<CONFLUENCE_UNTRUSTED")) {
    return "<<<CONFLUENCE_UNTRUSTED";
  }
  if (body.includes("<<<END_CONFLUENCE_UNTRUSTED>>>")) {
    return "<<<END_CONFLUENCE_UNTRUSTED>>>";
  }
  const canary = getSessionCanary();
  if (body.includes(canary)) {
    return canary;
  }
  return undefined;
}
