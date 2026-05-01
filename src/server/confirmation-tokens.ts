/**
 * Confirmation-token store for soft-elicitation (Phase 2 / v6.6.0).
 *
 * Trust boundary. This module mints/validates the single-use tokens that
 * stand in for an in-protocol elicitation prompt when the connected MCP
 * client does not advertise elicitation support (see plan §3.2 / §3.4).
 * A bug here can let a stale or wrong-page write bypass the confirmation
 * gate entirely; treat changes accordingly.
 *
 * Binding rules (all enforced below; cross-reference plan §3.2 notes 1-10):
 *
 *  1. Tokens are single-use. A successful validate consumes the token AND
 *     atomically invalidates every other outstanding token bound to the
 *     same `{cloudId, pageId}` (the sibling-invalidation TOCTOU guard,
 *     §3.2 note 7). Replay of any of those tokens returns "invalid".
 *
 *  2. Tokens never appear in error messages, log output, audit records,
 *     stderr, telemetry, or `console.error`. Audit hooks receive a
 *     per-mint `auditId` (UUID) for cross-system correlation.
 *
 *  3. Process-local in-memory only. No persistence, no cross-process
 *     sharing. The store is bounded:
 *       - MAX_OUTSTANDING_TOKENS = 50 (FIFO-evict on overflow).
 *       - MAX_MINTS_PER_15_MIN  = 100 (over-budget mints throw
 *         SOFT_CONFIRM_RATE_LIMITED). Override via
 *         EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT; "0" disables the cap.
 *
 *  4. TTL clamped to [60_000, 900_000] ms (1-15 min). Out-of-range values
 *     are silently clamped — never thrown — to avoid a config-value
 *     oracle. Clock source: Date.now().
 *
 *  5. validateToken enforces a 5 ms minimum wall-time floor regardless
 *     of outcome. Removes the timing-side-channel that a hash-Map lookup
 *     would otherwise leak to a colocated attacker.
 *
 *  6. Tokens are bound to ALL FIVE fields of ConfirmationContext:
 *     `tool`, `cloudId`, `pageId`, `pageVersion`, `diffHash`. Mismatch on
 *     any single field returns "invalid". The cloudId binding closes the
 *     "profile flips mid-session" multi-tenant replay vector.
 *
 *  7. validateToken returns Promise<"ok" | "invalid"> ONLY. Fine-grained
 *     reasons (`unknown`, `expired`, `stale`, `mismatch`, `evicted`)
 *     flow into the onValidate audit hook only. Returning richer reasons
 *     to the caller would expose a token-state oracle.
 *
 *  8. No public introspection API. Diagnostics are write-only via
 *     onMint / onValidate hooks. The earlier `_peekToken` proposal is
 *     gone (plan §3.2 note 9, security-review item 8).
 *
 *  9. Token bytes use `randomBytes(24).toString("base64url")`, NOT
 *     `randomUUID()` — the latter leaks version/variant nibbles that
 *     would otherwise be entropy.
 */

import { randomBytes, randomUUID, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConfirmationContext {
  /** Tool that minted the token (must match on validation). */
  tool: string;
  /**
   * Confluence cloudId of the tenant the token was minted against.
   * Mismatch on validate is treated as token-invalid — protects against
   * profile/tenant flips mid-session in long-lived MCP host processes.
   */
  cloudId: string;
  /** Page ID the token applies to. */
  pageId: string;
  /**
   * The page's version.number AT MINT TIME. Bound into the diffHash
   * inputs so a token minted for "apply diff X on top of v7" cannot
   * validate after the page has advanced past v7.
   */
  pageVersion: number;
  /**
   * Stable SHA-256 hash of the canonical post-prepare storage XML
   * (i.e. the exact bytes that were about to be PUT) plus pageVersion.
   * Computed via the shared `computeDiffHash` helper.
   */
  diffHash: string;
}

export interface ConfirmationToken {
  /** Opaque, ~24 bytes base64url. NEVER logged in full. */
  token: string;
  /** Stable per-mint UUID used for audit log correlation in place of the token. */
  auditId: string;
  /** ms since epoch */
  expiresAt: number;
}

export interface AuditMintMeta {
  auditId: string;
  tool: string;
  cloudId: string;
  pageId: string;
  pageVersion: number;
  expiresAt: number;
  outstanding: number;
}

export interface AuditValidateMeta {
  /** undefined when the token is unknown (never minted, or already evicted). */
  auditId: string | undefined;
  tool: string;
  cloudId: string;
  pageId: string;
  /**
   * Internal outcome — exposed only via the audit hook, never returned by
   * validateToken. "evicted" indicates the token had been FIFO-evicted by
   * a later mint before this validate ran; from the API caller's view it
   * collapses to "invalid".
   */
  outcome: "ok" | "unknown" | "expired" | "stale" | "mismatch" | "evicted";
}

// ---------------------------------------------------------------------------
// Constants (plan §3.2 / §3.6)
// ---------------------------------------------------------------------------

/** Default TTL for new tokens. Clamped to [60_000, 900_000] ms (1-15 min). */
export const DEFAULT_SOFT_CONFIRM_TTL_MS = 5 * 60 * 1000; // 5 min

/** TTL clamp window. */
const TTL_MIN_MS = 60_000;
const TTL_MAX_MS = 900_000;

/** Hard caps to bound abuse and memory use. */
export const MAX_OUTSTANDING_TOKENS = 50;
export const MAX_MINTS_PER_15_MIN = 100;
const MINT_WINDOW_MS = 15 * 60 * 1000;

/** Minimum wall-time for validateToken regardless of outcome. */
const MIN_VALIDATE_FLOOR_MS = 5;

/** Error code emitted when the rolling mint cap is exceeded. */
export const SOFT_CONFIRM_RATE_LIMITED = "SOFT_CONFIRM_RATE_LIMITED";

export class SoftConfirmRateLimitedError extends Error {
  readonly code = SOFT_CONFIRM_RATE_LIMITED;
  readonly current: number;
  readonly limit: number;
  readonly waitMs: number;
  constructor(current: number, limit: number, waitMs: number) {
    super(
      `Soft-confirmation mint cap exhausted: ${current} mints in the last 15 min, ` +
        `limit ${limit}. Window opens again in ~${Math.ceil(waitMs / 60_000)} min. ` +
        `Override via EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT (set "0" to disable).`,
    );
    this.name = "SoftConfirmRateLimitedError";
    this.current = current;
    this.limit = limit;
    this.waitMs = waitMs;
  }
}

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

interface StoredEntry {
  auditId: string;
  ctx: ConfirmationContext;
  expiresAt: number;
  /** Monotonic counter — used for FIFO eviction order, independent of the
   * mutable `Map` insertion-order semantics. */
  insertSeq: number;
}

/** token-string -> entry. Map iteration order is insertion order, but we
 * carry an explicit `insertSeq` anyway so eviction is stable even if the
 * implementation switches data structures later. */
const store = new Map<string, StoredEntry>();

/** Rolling timestamps of mint() calls; used for the 15-min cap. */
let mintTimestamps: number[] = [];

/** Strictly-increasing sequence number for FIFO eviction. */
let insertSeqCounter = 0;

/** Audit hooks (write-only; no public read API). Multiple subscribers OK
 * to keep tests independent of one another. */
const mintHandlers: Array<(meta: AuditMintMeta) => void> = [];
const validateHandlers: Array<(meta: AuditValidateMeta) => void> = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return DEFAULT_SOFT_CONFIRM_TTL_MS;
  if (ttlMs < TTL_MIN_MS) return TTL_MIN_MS;
  if (ttlMs > TTL_MAX_MS) return TTL_MAX_MS;
  return ttlMs;
}

/**
 * Resolve the rolling-window mint cap. EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT
 * overrides the default; "0" disables. Negative or unparseable values fall
 * back to the default (silent — surfacing them would be a config oracle).
 */
function getMintLimit(): number {
  const raw = process.env.EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT;
  if (raw === undefined) return MAX_MINTS_PER_15_MIN;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return MAX_MINTS_PER_15_MIN;
  return n;
}

/** Resolve the default TTL, with env override clamped to the same window. */
function getDefaultTtl(): number {
  const raw = process.env.EPIMETHIAN_SOFT_CONFIRM_TTL_MS;
  if (raw === undefined) return DEFAULT_SOFT_CONFIRM_TTL_MS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_SOFT_CONFIRM_TTL_MS;
  return clampTtl(n);
}

function emitMint(meta: AuditMintMeta): void {
  for (const h of mintHandlers) {
    try {
      h(meta);
    } catch {
      // Audit handlers are best-effort. A throwing subscriber MUST NOT
      // break minting (we already issued the token at this point).
    }
  }
}

function emitValidate(meta: AuditValidateMeta): void {
  for (const h of validateHandlers) {
    try {
      h(meta);
    } catch {
      // Same posture as emitMint — diagnostics are best-effort.
    }
  }
}

/**
 * Sleep until `targetWallClockMs` (Date.now()-based). Used to enforce the
 * 5 ms validateToken floor. Resolves immediately if the deadline has
 * already passed.
 */
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

/**
 * Constant-time-ish equality for two strings of equal length. Plain `===`
 * is fine for the lookup itself (we're keying a Map by the token string,
 * not comparing it for cryptographic purposes), but for the post-lookup
 * field comparisons on cloudId/pageId/etc we use simple equality — those
 * fields are not secrets and timing on them is not security-relevant.
 * (Documented for the human reviewer: cloudId/pageId/diffHash are
 * tenant-attestable values, not secrets.)
 */

/** Drop expired mint timestamps from the rolling window. */
function pruneMintTimestamps(now: number): void {
  const cutoff = now - MINT_WINDOW_MS;
  if (mintTimestamps.length === 0) return;
  // Hot path optimisation: if the head is fresh, skip the filter.
  if (mintTimestamps[0]! >= cutoff) return;
  mintTimestamps = mintTimestamps.filter((ts) => ts >= cutoff);
}

/**
 * FIFO-evict the oldest entry to make room. Fires onValidate with
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
  emitValidate({
    auditId: entry.auditId,
    tool: entry.ctx.tool,
    cloudId: entry.ctx.cloudId,
    pageId: entry.ctx.pageId,
    outcome: "evicted",
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mint a fresh token bound to the given context.
 *
 * Throws `SoftConfirmRateLimitedError` (code SOFT_CONFIRM_RATE_LIMITED)
 * when the rolling 15-min mint cap is reached. The chosen TTL is clamped
 * to [60_000, 900_000] ms regardless of input or env override; the caller
 * never sees the raw randomness — `auditId` is used for cross-system
 * correlation.
 *
 * The token is minted atomically with rate-limit accounting and FIFO
 * eviction: by the time this function returns, the store contains exactly
 * one entry for the new token, and `outstanding` (in the audit hook) is
 * the post-mint count.
 */
export function mintToken(
  ctx: ConfirmationContext,
  ttlMs?: number,
): ConfirmationToken {
  const now = Date.now();
  pruneMintTimestamps(now);

  const limit = getMintLimit();
  if (limit > 0 && mintTimestamps.length >= limit) {
    const oldest = mintTimestamps[0]!;
    const waitMs = Math.max(0, oldest + MINT_WINDOW_MS - now);
    throw new SoftConfirmRateLimitedError(
      mintTimestamps.length,
      limit,
      waitMs,
    );
  }

  // FIFO-evict to keep store bounded. We evict BEFORE inserting so the
  // post-insert size is exactly MAX_OUTSTANDING_TOKENS.
  while (store.size >= MAX_OUTSTANDING_TOKENS) {
    evictOldest();
  }

  const resolvedTtl = clampTtl(ttlMs ?? getDefaultTtl());
  const expiresAt = now + resolvedTtl;
  const auditId = randomUUID();
  const tokenStr = randomBytes(24).toString("base64url");

  store.set(tokenStr, {
    auditId,
    ctx: { ...ctx },
    expiresAt,
    insertSeq: ++insertSeqCounter,
  });
  mintTimestamps.push(now);

  emitMint({
    auditId,
    tool: ctx.tool,
    cloudId: ctx.cloudId,
    pageId: ctx.pageId,
    pageVersion: ctx.pageVersion,
    expiresAt,
    outstanding: store.size,
  });

  return { token: tokenStr, auditId, expiresAt };
}

/**
 * Validate a token against the context.
 *
 * Always blocks for at least MIN_VALIDATE_FLOOR_MS (5 ms) before
 * returning, regardless of outcome. The Map lookup itself is hash-based
 * and would otherwise leak hit/miss timing.
 *
 * Returns ONLY two outcomes externally:
 *  - "ok"      — token exists, matches ctx on every field, not expired.
 *                Token is consumed (single-use) AND every other
 *                outstanding token for the same {cloudId, pageId} is
 *                invalidated atomically (closes the concurrent-retries
 *                TOCTOU window).
 *  - "invalid" — every other case (unknown, expired, stale, mismatch).
 *                The specific reason is recorded only via `onValidate`.
 *                External callers see one bucket — distinguishing them
 *                at the API layer would leak a token-state oracle.
 */
export async function validateToken(
  token: string,
  ctx: ConfirmationContext,
): Promise<"ok" | "invalid"> {
  const floorTarget = Date.now() + MIN_VALIDATE_FLOOR_MS;

  // Compute the outcome synchronously, then sleep to the floor. We do
  // NOT short-circuit on hit: the floor is the whole point — both paths
  // must observably take >= 5 ms.
  let outcome: AuditValidateMeta["outcome"];
  let auditId: string | undefined;

  const entry = store.get(token);
  if (!entry) {
    outcome = "unknown";
  } else {
    auditId = entry.auditId;
    const now = Date.now();
    if (now >= entry.expiresAt) {
      // Expired — remove it lazily on validate.
      store.delete(token);
      outcome = "expired";
    } else if (
      entry.ctx.tool !== ctx.tool ||
      entry.ctx.cloudId !== ctx.cloudId ||
      entry.ctx.pageId !== ctx.pageId ||
      entry.ctx.pageVersion !== ctx.pageVersion ||
      entry.ctx.diffHash !== ctx.diffHash
    ) {
      // Mismatch on any of the five bound fields. Do NOT consume the
      // token — caller may retry with corrected context. (Single-use is
      // a property of "ok", not of "any lookup".)
      outcome = "mismatch";
    } else {
      // Successful validate. Consume the token AND atomically invalidate
      // every other outstanding token bound to the same {cloudId,
      // pageId}. The latter siblings get audit outcome "stale" so the
      // postmortem records they were dropped, not silently lost.
      store.delete(token);
      const siblings: Array<[string, StoredEntry]> = [];
      for (const [k, v] of store.entries()) {
        if (
          v.ctx.cloudId === entry.ctx.cloudId &&
          v.ctx.pageId === entry.ctx.pageId
        ) {
          siblings.push([k, v]);
        }
      }
      for (const [k, v] of siblings) {
        store.delete(k);
        emitValidate({
          auditId: v.auditId,
          tool: v.ctx.tool,
          cloudId: v.ctx.cloudId,
          pageId: v.ctx.pageId,
          outcome: "stale",
        });
      }
      outcome = "ok";
    }
  }

  emitValidate({
    auditId,
    tool: ctx.tool,
    cloudId: ctx.cloudId,
    pageId: ctx.pageId,
    outcome,
  });

  await sleepUntil(floorTarget);

  return outcome === "ok" ? "ok" : "invalid";
}

/**
 * Invalidate every token bound to this {cloudId, pageId}.
 *
 * Called from the safe-write success path (defense-in-depth: any
 * successful write to a page invalidates all soft-confirmation tokens
 * minted against it, even ones that didn't gate that write). Each
 * dropped token fires `onValidate` with outcome "stale" so the audit
 * trail captures the invalidation.
 */
export function invalidateForPage(cloudId: string, pageId: string): void {
  const victims: Array<[string, StoredEntry]> = [];
  for (const [k, v] of store.entries()) {
    if (v.ctx.cloudId === cloudId && v.ctx.pageId === pageId) {
      victims.push([k, v]);
    }
  }
  for (const [k, v] of victims) {
    store.delete(k);
    emitValidate({
      auditId: v.auditId,
      tool: v.ctx.tool,
      cloudId: v.ctx.cloudId,
      pageId: v.ctx.pageId,
      outcome: "stale",
    });
  }
}

/**
 * Stable SHA-256 of `${canonicalStorageXml}\n${pageVersion}`, hex-
 * encoded. Two outputs differ if the storage XML differs by even one
 * byte OR if the page version differs. Shared between mint and validate
 * sites so the binding is deterministic.
 */
export function computeDiffHash(
  canonicalStorageXml: string,
  pageVersion: number,
): string {
  return createHash("sha256")
    .update(`${canonicalStorageXml}\n${pageVersion}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Audit hook registration (write-only)
// ---------------------------------------------------------------------------

/** Register a handler called after every successful mint. Multiple
 * subscribers permitted; handler errors are swallowed. */
export function onMint(handler: (meta: AuditMintMeta) => void): void {
  mintHandlers.push(handler);
}

/** Register a handler called after every validate (and on FIFO eviction
 * and on per-page invalidation). Handler errors are swallowed. */
export function onValidate(handler: (meta: AuditValidateMeta) => void): void {
  validateHandlers.push(handler);
}

// ---------------------------------------------------------------------------
// Test-only reset
// ---------------------------------------------------------------------------

/** Testing-only: clear all internal state including registered hooks. */
export function _resetForTest(): void {
  store.clear();
  mintTimestamps = [];
  insertSeqCounter = 0;
  mintHandlers.length = 0;
  validateHandlers.length = 0;
}
