/**
 * Batch confirmation tokens (v6.8.0 / Option C of
 * `plans/parallel-subagent-batch-confirmation.md`).
 *
 * Mints a single token that pre-authorises destructive writes to an
 * explicit list of page IDs. The token is consumed by subsequent
 * `update_page` / `update_page_section` / `update_page_sections` /
 * `delete_page` calls (potentially across many sub-agents) without
 * each call going through its own elicitation round-trip.
 *
 * Trust boundary. This module is one of two soft-confirm surfaces that
 * can authorise destructive writes (the other being
 * `confirmation-tokens.ts`). A bug here can authorise writes the user
 * never approved; treat changes accordingly.
 *
 * Design plan: `plans/parallel-subagent-batch-confirmation.md`. Key
 * properties cross-referenced below:
 *
 *  1. **Page-id allowlist (no wildcards).** A token is bound to an
 *     explicit list of page IDs. Validation rejects any page_id not in
 *     the list — this is the primary defence against
 *     prompt-injection-redirected writes.
 *
 *  2. **Reservation-style operation accounting.** validateBatchToken
 *     returns a `reservationId` and atomically decrements the
 *     remaining-operations counter. The caller MUST either let the
 *     reservation finalise (the write reached the server, success or
 *     HTTP-error: keep the slot consumed) OR call `refundReservation`
 *     for local / pre-flight failures (the request never reached
 *     Confluence: refund the slot). The ambiguous case (write may have
 *     committed but the response was lost) keeps the slot consumed —
 *     we cannot prove the remote did not mutate.
 *
 *  3. **Validation-failure invariant (mirrors §6 of
 *     `confirmation-tokens.ts`).** validateBatchToken returns
 *     `{ valid: true, reservationId } | { valid: false }`. Granular
 *     reasons (`unknown`, `expired`, `cloudid_mismatch`,
 *     `page_id_not_authorised`, `exhausted`) flow ONLY into the
 *     `onValidate` audit hook. Returning richer reasons would let a
 *     malicious orchestrator probe the token store ("which page IDs
 *     are authorised right now?", "is this token expired or did I
 *     never have it?").
 *
 *  4. **Tokens never appear in logs / errors / audit records.** The
 *     audit hooks receive a per-mint `auditId` (UUID) for cross-system
 *     correlation. Same posture as `confirmation-tokens.ts`.
 *
 *  5. **Process-local in-memory only.** No persistence, no
 *     cross-process sharing. The store is bounded:
 *       - MAX_OUTSTANDING_BATCH_TOKENS = 25 (FIFO-evict on overflow).
 *       - MAX_BATCH_MINTS_PER_15_MIN = 25 (over-budget mints throw
 *         BATCH_MINT_RATE_LIMITED). Override via
 *         EPIMETHIAN_BATCH_MINT_LIMIT; "0" disables.
 *     This budget is INDEPENDENT of `confirmation-tokens.ts`'s budget
 *     — batch authorisations are a different threat model (one mint
 *     authorises N writes, not 1) and shouldn't share counters.
 *
 *  6. **TTL clamped to [60s, 3600s].** Out-of-range values are
 *     silently clamped — never thrown — to avoid a config-value
 *     oracle.
 *
 *  7. **page_ids list capped at MAX_PAGE_IDS_PER_BATCH = 50.**
 *     `max_operations` capped at `page_ids.length × 2` (network-retry
 *     headroom; not an application-level retry budget).
 *
 *  8. **5 ms validate floor.** Same timing-side-channel resistance as
 *     `confirmation-tokens.ts`.
 *
 *  9. **Token bytes use `randomBytes(32).toString("hex")`** prefixed
 *     with `btk_`. 64 hex chars + 4-char prefix = 68 chars. Distinct
 *     from confirmation-tokens (which use base64url and no prefix) so
 *     the two can't be silently swapped.
 */

import { randomBytes, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BatchTokenMintArgs {
  /** Confluence cloudId of the tenant the token is valid for. */
  cloudId: string;
  /**
   * Explicit allowlist of page IDs the token authorises writes to.
   * 1..MAX_PAGE_IDS_PER_BATCH entries. Duplicates are normalised away.
   */
  pageIds: string[];
  /**
   * Token lifetime in seconds. Clamped to [60, 3600]. Defaults to
   * DEFAULT_BATCH_TTL_SECONDS (900).
   */
  ttlSeconds?: number;
  /**
   * Operation cap. Defaults to `pageIds.length` (one successful write
   * per page). Maximum allowed is `pageIds.length × 2` —
   * network-retry headroom that the server cannot distinguish from
   * real conflicts; not an application-level retry budget.
   */
  maxOperations?: number;
}

export interface BatchToken {
  /** Opaque token: `btk_` prefix + 64 hex chars. NEVER logged in full. */
  token: string;
  /** Stable per-mint UUID for audit log correlation in place of the token. */
  auditId: string;
  /** ms since epoch */
  expiresAt: number;
  /**
   * The page IDs the token authorises (deduplicated, in input order
   * minus duplicates).
   */
  authorisedPageIds: string[];
  /** Initial remaining-operations counter. */
  remainingOperations: number;
}

export interface BatchValidateArgs {
  token: string;
  cloudId: string;
  pageId: string;
}

export interface BatchValidateOk {
  valid: true;
  reservationId: string;
}

export interface BatchValidateInvalid {
  valid: false;
}

export type BatchValidateResult = BatchValidateOk | BatchValidateInvalid;

export interface BatchAuditMintMeta {
  auditId: string;
  cloudId: string;
  pageIds: string[];
  ttlMs: number;
  maxOperations: number;
  expiresAt: number;
  outstanding: number;
}

export interface BatchAuditValidateMeta {
  /** undefined when the token is unknown (never minted, or evicted). */
  auditId: string | undefined;
  cloudId: string;
  pageId: string;
  /**
   * Internal outcome. Exposed only via the audit hook, never returned
   * by validateBatchToken. "evicted" indicates the token had been
   * FIFO-evicted by a later mint before this validate ran; from the
   * API caller's view it collapses to "invalid".
   */
  outcome:
    | "ok"
    | "unknown"
    | "expired"
    | "cloudid_mismatch"
    | "page_id_not_authorised"
    | "exhausted"
    | "evicted";
  /**
   * Remaining operations AFTER the reservation (only meaningful when
   * outcome === "ok"). Useful for observability.
   */
  remainingAfter?: number;
}

export interface BatchAuditRefundMeta {
  auditId: string;
  cloudId: string;
  pageId: string;
  /** Whether the refund actually incremented the counter. */
  refunded: boolean;
  /** Remaining operations AFTER the refund. */
  remainingAfter: number;
}

// ---------------------------------------------------------------------------
// Constants (plan §3 / §Versioning)
// ---------------------------------------------------------------------------

/** Default TTL for new batch tokens. Clamped to [60s, 3600s]. */
export const DEFAULT_BATCH_TTL_SECONDS = 15 * 60; // 15 min

const TTL_MIN_SECONDS = 60;
const TTL_MAX_SECONDS = 60 * 60;

/** Maximum page IDs in a single batch. */
export const MAX_PAGE_IDS_PER_BATCH = 50;

/** Hard caps on store size and mint rate. */
export const MAX_OUTSTANDING_BATCH_TOKENS = 25;
export const MAX_BATCH_MINTS_PER_15_MIN = 25;
const MINT_WINDOW_MS = 15 * 60 * 1000;

/** Minimum wall-time for validateBatchToken regardless of outcome. */
const MIN_VALIDATE_FLOOR_MS = 5;

/** Error code for the rolling-window mint cap. */
export const BATCH_MINT_RATE_LIMITED = "BATCH_MINT_RATE_LIMITED";

export class BatchMintRateLimitedError extends Error {
  readonly code = BATCH_MINT_RATE_LIMITED;
  readonly current: number;
  readonly limit: number;
  readonly waitMs: number;
  constructor(current: number, limit: number, waitMs: number) {
    super(
      `Batch authorisation mint cap exhausted: ${current} mints in the last 15 min, ` +
        `limit ${limit}. Window opens again in ~${Math.ceil(waitMs / 60_000)} min. ` +
        `Override via EPIMETHIAN_BATCH_MINT_LIMIT (set "0" to disable).`,
    );
    this.name = "BatchMintRateLimitedError";
    this.current = current;
    this.limit = limit;
    this.waitMs = waitMs;
  }
}

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

interface ReservationEntry {
  pageId: string;
  refunded: boolean;
}

interface StoredEntry {
  auditId: string;
  cloudId: string;
  pageIds: Set<string>;
  pageIdsList: string[];
  expiresAt: number;
  maxOperations: number;
  remainingOperations: number;
  reservations: Map<string, ReservationEntry>;
  insertSeq: number;
}

/** token -> entry */
const store = new Map<string, StoredEntry>();

/** reservationId -> token (so refundReservation can locate the parent token) */
const reservationIndex = new Map<string, string>();

/** Rolling timestamps of mint() calls; used for the 15-min cap. */
let mintTimestamps: number[] = [];

/** Strictly-increasing sequence number for FIFO eviction. */
let insertSeqCounter = 0;

const mintHandlers: Array<(meta: BatchAuditMintMeta) => void> = [];
const validateHandlers: Array<(meta: BatchAuditValidateMeta) => void> = [];
const refundHandlers: Array<(meta: BatchAuditRefundMeta) => void> = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampTtlSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_BATCH_TTL_SECONDS;
  if (seconds < TTL_MIN_SECONDS) return TTL_MIN_SECONDS;
  if (seconds > TTL_MAX_SECONDS) return TTL_MAX_SECONDS;
  return Math.floor(seconds);
}

/**
 * Resolve the rolling-window mint cap. EPIMETHIAN_BATCH_MINT_LIMIT
 * overrides the default; "0" disables. Negative or unparseable values
 * fall back to the default (silent — surfacing them would be a config
 * oracle).
 */
function getMintLimit(): number {
  const raw = process.env.EPIMETHIAN_BATCH_MINT_LIMIT;
  if (raw === undefined) return MAX_BATCH_MINTS_PER_15_MIN;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return MAX_BATCH_MINTS_PER_15_MIN;
  return n;
}

function emitMint(meta: BatchAuditMintMeta): void {
  for (const h of mintHandlers) {
    try {
      h(meta);
    } catch {
      // best-effort
    }
  }
}

function emitValidate(meta: BatchAuditValidateMeta): void {
  for (const h of validateHandlers) {
    try {
      h(meta);
    } catch {
      // best-effort
    }
  }
}

function emitRefund(meta: BatchAuditRefundMeta): void {
  for (const h of refundHandlers) {
    try {
      h(meta);
    } catch {
      // best-effort
    }
  }
}

function sleepUntil(targetWallClockMs: number): Promise<void> {
  return new Promise((resolve) => {
    const remaining = targetWallClockMs - Date.now();
    if (remaining <= 0) {
      resolve();
      return;
    }
    setTimeout(resolve, remaining);
  });
}

function pruneMintTimestamps(now: number): void {
  const cutoff = now - MINT_WINDOW_MS;
  if (mintTimestamps.length === 0) return;
  if (mintTimestamps[0]! >= cutoff) return;
  mintTimestamps = mintTimestamps.filter((ts) => ts >= cutoff);
}

/**
 * FIFO-evict the oldest entry to make room. Each evicted reservation
 * is removed from the reservation index. Fires onValidate with
 * outcome "evicted" so the audit log records that the token can no
 * longer be redeemed even if the agent still holds it.
 */
function evictOldest(): void {
  let oldestKey: string | undefined;
  let oldestSeq = Infinity;
  for (const [k, v] of store.entries()) {
    if (v.insertSeq < oldestSeq) {
      oldestSeq = v.insertSeq;
      oldestKey = k;
    }
  }
  if (oldestKey === undefined) return;
  const entry = store.get(oldestKey)!;
  store.delete(oldestKey);
  for (const reservationId of entry.reservations.keys()) {
    reservationIndex.delete(reservationId);
  }
  // Fire one synthetic validate event with the FIRST page in the
  // allowlist. Without a real validation site we have no concrete
  // page_id to report; the auditId is the cross-system handle.
  emitValidate({
    auditId: entry.auditId,
    cloudId: entry.cloudId,
    pageId: entry.pageIdsList[0] ?? "",
    outcome: "evicted",
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mint a fresh batch authorisation token bound to the given page-id
 * allowlist.
 *
 * Throws `BatchMintRateLimitedError` when the rolling 15-min mint cap
 * is reached. Throws `Error` on input validation failures
 * (cloudId/pageIds malformed, list empty, list over the cap).
 *
 * `ttlSeconds` and `maxOperations` are silently clamped to their valid
 * ranges (no oracle on out-of-range values).
 */
export function mintBatchToken(args: BatchTokenMintArgs): BatchToken {
  if (typeof args.cloudId !== "string" || args.cloudId.length === 0) {
    throw new Error("mintBatchToken: cloudId is required and must be a non-empty string.");
  }
  if (!Array.isArray(args.pageIds) || args.pageIds.length === 0) {
    throw new Error("mintBatchToken: pageIds must be a non-empty array.");
  }

  // Deduplicate while preserving input order. Reject any non-string
  // entry — calling code passed something through that the schema
  // should have caught, so be loud rather than lossy.
  const seen = new Set<string>();
  const dedupedPageIds: string[] = [];
  for (const id of args.pageIds) {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("mintBatchToken: every page_id must be a non-empty string.");
    }
    if (!seen.has(id)) {
      seen.add(id);
      dedupedPageIds.push(id);
    }
  }
  if (dedupedPageIds.length > MAX_PAGE_IDS_PER_BATCH) {
    throw new Error(
      `mintBatchToken: page_ids list exceeds MAX_PAGE_IDS_PER_BATCH=${MAX_PAGE_IDS_PER_BATCH}.`,
    );
  }

  const ttlSeconds = clampTtlSeconds(args.ttlSeconds ?? DEFAULT_BATCH_TTL_SECONDS);
  const ttlMs = ttlSeconds * 1000;

  // max_operations: default to N (one write per page); cap at N×2.
  const N = dedupedPageIds.length;
  const requestedMax =
    args.maxOperations === undefined ? N : Math.floor(args.maxOperations);
  if (!Number.isFinite(requestedMax) || requestedMax < 1) {
    throw new Error("mintBatchToken: max_operations must be a positive integer.");
  }
  const maxOperations = Math.min(requestedMax, N * 2);

  const now = Date.now();
  pruneMintTimestamps(now);

  const limit = getMintLimit();
  if (limit > 0 && mintTimestamps.length >= limit) {
    const oldest = mintTimestamps[0]!;
    const waitMs = Math.max(0, oldest + MINT_WINDOW_MS - now);
    throw new BatchMintRateLimitedError(mintTimestamps.length, limit, waitMs);
  }

  while (store.size >= MAX_OUTSTANDING_BATCH_TOKENS) {
    evictOldest();
  }

  const expiresAt = now + ttlMs;
  const auditId = randomUUID();
  const tokenStr = `btk_${randomBytes(32).toString("hex")}`;

  const entry: StoredEntry = {
    auditId,
    cloudId: args.cloudId,
    pageIds: new Set(dedupedPageIds),
    pageIdsList: dedupedPageIds,
    expiresAt,
    maxOperations,
    remainingOperations: maxOperations,
    reservations: new Map(),
    insertSeq: ++insertSeqCounter,
  };
  store.set(tokenStr, entry);
  mintTimestamps.push(now);

  emitMint({
    auditId,
    cloudId: args.cloudId,
    pageIds: dedupedPageIds,
    ttlMs,
    maxOperations,
    expiresAt,
    outstanding: store.size,
  });

  return {
    token: tokenStr,
    auditId,
    expiresAt,
    authorisedPageIds: dedupedPageIds,
    remainingOperations: maxOperations,
  };
}

/**
 * Validate a batch token against a write request and atomically
 * reserve one operation slot.
 *
 * Always blocks for at least MIN_VALIDATE_FLOOR_MS regardless of
 * outcome.
 *
 * Returns ONLY two shapes externally:
 *   - `{ valid: true, reservationId }` — token is valid for this
 *     {cloudId, pageId}, the remaining-operations counter has been
 *     decremented, and `reservationId` MUST be passed to
 *     `refundReservation` if the caller fails before the write reaches
 *     Confluence. Otherwise the slot stays consumed (the right
 *     answer for "the request reached the server, success or HTTP-
 *     error").
 *   - `{ valid: false }` — every other case (unknown, expired,
 *     cloudid mismatch, page_id not in allowlist, exhausted). The
 *     specific reason is recorded only via `onValidate`. External
 *     callers see one bucket — distinguishing them at the API layer
 *     would leak a token-state oracle.
 */
export async function validateBatchToken(
  args: BatchValidateArgs,
): Promise<BatchValidateResult> {
  const floorTarget = Date.now() + MIN_VALIDATE_FLOOR_MS;

  let outcome: BatchAuditValidateMeta["outcome"];
  let auditId: string | undefined;
  let result: BatchValidateResult = { valid: false };
  let remainingAfter: number | undefined;

  const entry = store.get(args.token);
  if (!entry) {
    outcome = "unknown";
  } else {
    auditId = entry.auditId;
    const now = Date.now();
    if (now >= entry.expiresAt) {
      // Lazy expiry sweep on validate. Drop the entry and any
      // outstanding reservations associated with it (those have no
      // refund path now that the parent token is gone).
      store.delete(args.token);
      for (const reservationId of entry.reservations.keys()) {
        reservationIndex.delete(reservationId);
      }
      outcome = "expired";
    } else if (entry.cloudId !== args.cloudId) {
      outcome = "cloudid_mismatch";
    } else if (!entry.pageIds.has(args.pageId)) {
      outcome = "page_id_not_authorised";
    } else if (entry.remainingOperations <= 0) {
      outcome = "exhausted";
    } else {
      // Reserve.
      entry.remainingOperations -= 1;
      remainingAfter = entry.remainingOperations;
      const reservationId = randomUUID();
      entry.reservations.set(reservationId, {
        pageId: args.pageId,
        refunded: false,
      });
      reservationIndex.set(reservationId, args.token);
      outcome = "ok";
      result = { valid: true, reservationId };
    }
  }

  emitValidate({
    auditId,
    cloudId: args.cloudId,
    pageId: args.pageId,
    outcome,
    ...(remainingAfter !== undefined ? { remainingAfter } : {}),
  });

  await sleepUntil(floorTarget);

  return result;
}

/**
 * Refund a reservation. Idempotent — calling twice on the same
 * reservationId is a no-op on the second call.
 *
 * Call this when the underlying write fails locally / pre-flight
 * (schema validation, conversion error, request never dispatched).
 * Do NOT call this for HTTP errors after dispatch — the server may
 * have committed the write and lost the response, in which case the
 * slot should remain consumed.
 *
 * Returns true if the slot was actually refunded; false if the
 * reservation was unknown or had already been refunded. The boolean
 * is observability-only; treat both as "the caller's intent has been
 * recorded, move on."
 */
export function refundReservation(reservationId: string): boolean {
  const tokenStr = reservationIndex.get(reservationId);
  if (tokenStr === undefined) return false;
  const entry = store.get(tokenStr);
  if (!entry) {
    // Token has expired or been evicted between reserve and refund;
    // the reservation index is stale. Clean it up.
    reservationIndex.delete(reservationId);
    return false;
  }
  const reservation = entry.reservations.get(reservationId);
  if (!reservation) return false;
  if (reservation.refunded) {
    emitRefund({
      auditId: entry.auditId,
      cloudId: entry.cloudId,
      pageId: reservation.pageId,
      refunded: false,
      remainingAfter: entry.remainingOperations,
    });
    return false;
  }
  reservation.refunded = true;
  entry.remainingOperations += 1;
  emitRefund({
    auditId: entry.auditId,
    cloudId: entry.cloudId,
    pageId: reservation.pageId,
    refunded: true,
    remainingAfter: entry.remainingOperations,
  });
  return true;
}

/**
 * Mark a reservation as finalised (no-op on the counter — the reserve
 * already decremented it). Currently used to drop the reservation
 * record so long-running tokens don't accumulate stale entries. Safe
 * to skip in callers that don't want the bookkeeping.
 */
export function finaliseReservation(reservationId: string): void {
  const tokenStr = reservationIndex.get(reservationId);
  reservationIndex.delete(reservationId);
  if (tokenStr === undefined) return;
  const entry = store.get(tokenStr);
  if (!entry) return;
  entry.reservations.delete(reservationId);
}

/**
 * Token-shape pre-check used by callers that want to short-circuit
 * before touching the store. Returns true iff the input string has
 * the `btk_` prefix and the right length. Distinct from validation —
 * this is a syntactic filter only.
 */
export function isBatchTokenShape(token: string): boolean {
  if (typeof token !== "string") return false;
  if (!token.startsWith("btk_")) return false;
  if (token.length !== "btk_".length + 64) return false;
  // Hex check on the body.
  for (let i = 4; i < token.length; i++) {
    const c = token.charCodeAt(i);
    const isHex =
      (c >= 48 && c <= 57) || // 0-9
      (c >= 97 && c <= 102) || // a-f
      (c >= 65 && c <= 70); // A-F
    if (!isHex) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Audit hook registration (write-only)
// ---------------------------------------------------------------------------

export function onMintBatch(handler: (meta: BatchAuditMintMeta) => void): void {
  mintHandlers.push(handler);
}

export function onValidateBatch(
  handler: (meta: BatchAuditValidateMeta) => void,
): void {
  validateHandlers.push(handler);
}

export function onRefundBatch(handler: (meta: BatchAuditRefundMeta) => void): void {
  refundHandlers.push(handler);
}

// ---------------------------------------------------------------------------
// Test-only reset
// ---------------------------------------------------------------------------

export function _resetBatchTokensForTest(): void {
  store.clear();
  reservationIndex.clear();
  mintTimestamps = [];
  insertSeqCounter = 0;
  mintHandlers.length = 0;
  validateHandlers.length = 0;
  refundHandlers.length = 0;
}
