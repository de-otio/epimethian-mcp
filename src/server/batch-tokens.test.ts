/**
 * Tests for the batch-token store (v6.8.0 / Option C).
 *
 * Pinned invariants (cross-reference plan §3 of
 * `plans/parallel-subagent-batch-confirmation.md`):
 *
 *  - Page-id allowlist enforcement (no wildcards).
 *  - Reservation/refund accounting (idempotent refund; no double-decrement).
 *  - Validation-failure invariant: `{ valid: false }` is the only
 *    externally-visible failure shape; granular reasons live in the
 *    audit hook only (oracle resistance).
 *  - TTL clamp [60, 3600] seconds.
 *  - Mint rate limit + FIFO eviction.
 *  - Token shape syntactic check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type BatchAuditMintMeta,
  type BatchAuditRefundMeta,
  type BatchAuditValidateMeta,
  BATCH_MINT_RATE_LIMITED,
  BatchMintRateLimitedError,
  DEFAULT_BATCH_TTL_SECONDS,
  MAX_BATCH_MINTS_PER_15_MIN,
  MAX_OUTSTANDING_BATCH_TOKENS,
  MAX_PAGE_IDS_PER_BATCH,
  _resetBatchTokensForTest,
  finaliseReservation,
  isBatchTokenShape,
  mintBatchToken,
  onMintBatch,
  onRefundBatch,
  onValidateBatch,
  refundReservation,
  validateBatchToken,
} from "./batch-tokens.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLOUD_A = "cloud-A";
const CLOUD_B = "cloud-B";

beforeEach(() => {
  _resetBatchTokensForTest();
  delete process.env.EPIMETHIAN_BATCH_MINT_LIMIT;
});

afterEach(() => {
  vi.useRealTimers();
  _resetBatchTokensForTest();
  delete process.env.EPIMETHIAN_BATCH_MINT_LIMIT;
});

// ===========================================================================
// Mint
// ===========================================================================

describe("mintBatchToken", () => {
  it("returns a token with the btk_ prefix and 64 hex chars", () => {
    const t = mintBatchToken({ cloudId: CLOUD_A, pageIds: ["p1"] });
    expect(t.token.startsWith("btk_")).toBe(true);
    expect(t.token.length).toBe(4 + 64);
    expect(/^btk_[0-9a-f]{64}$/.test(t.token)).toBe(true);
  });

  it("returns the deduplicated authorisedPageIds in input order", () => {
    const t = mintBatchToken({
      cloudId: CLOUD_A,
      pageIds: ["p3", "p1", "p3", "p2", "p1"],
    });
    expect(t.authorisedPageIds).toEqual(["p3", "p1", "p2"]);
  });

  it("defaults max_operations to page_ids.length when not specified", () => {
    const t = mintBatchToken({ cloudId: CLOUD_A, pageIds: ["a", "b", "c"] });
    expect(t.remainingOperations).toBe(3);
  });

  it("caps max_operations at page_ids.length × 2 even if a higher value is requested", () => {
    const t = mintBatchToken({
      cloudId: CLOUD_A,
      pageIds: ["a", "b", "c"],
      maxOperations: 100,
    });
    expect(t.remainingOperations).toBe(6);
  });

  it("clamps ttl_seconds below 60s up to 60s (no oracle)", () => {
    const before = Date.now();
    const t = mintBatchToken({
      cloudId: CLOUD_A,
      pageIds: ["a"],
      ttlSeconds: 5,
    });
    const after = Date.now();
    expect(t.expiresAt - before).toBeGreaterThanOrEqual(60_000);
    expect(t.expiresAt - after).toBeLessThanOrEqual(60_000);
  });

  it("clamps ttl_seconds above 3600s down to 3600s", () => {
    const before = Date.now();
    const t = mintBatchToken({
      cloudId: CLOUD_A,
      pageIds: ["a"],
      ttlSeconds: 999_999,
    });
    expect(t.expiresAt - before).toBeLessThanOrEqual(3600_000 + 50);
    expect(t.expiresAt - before).toBeGreaterThanOrEqual(3600_000 - 50);
  });

  it("rejects empty pageIds array", () => {
    expect(() => mintBatchToken({ cloudId: CLOUD_A, pageIds: [] })).toThrow(
      /non-empty array/,
    );
  });

  it("rejects empty cloudId", () => {
    expect(() => mintBatchToken({ cloudId: "", pageIds: ["a"] })).toThrow(
      /cloudId/,
    );
  });

  it("rejects pageIds list above the cap", () => {
    const tooMany = Array.from({ length: MAX_PAGE_IDS_PER_BATCH + 1 }, (_, i) =>
      String(i),
    );
    expect(() => mintBatchToken({ cloudId: CLOUD_A, pageIds: tooMany })).toThrow(
      /MAX_PAGE_IDS_PER_BATCH/,
    );
  });

  it("rejects non-string page_id entries", () => {
    expect(() =>
      mintBatchToken({
        cloudId: CLOUD_A,
        pageIds: ["a", 42 as unknown as string],
      }),
    ).toThrow(/non-empty string/);
  });

  it("rejects max_operations < 1", () => {
    expect(() =>
      mintBatchToken({
        cloudId: CLOUD_A,
        pageIds: ["a"],
        maxOperations: 0,
      }),
    ).toThrow(/positive integer/);
  });

  it("emits onMint with audit metadata (no token bytes)", () => {
    const audits: BatchAuditMintMeta[] = [];
    onMintBatch((m) => audits.push(m));
    const t = mintBatchToken({ cloudId: CLOUD_A, pageIds: ["a", "b"] });

    expect(audits).toHaveLength(1);
    expect(audits[0]!.auditId).toBe(t.auditId);
    expect(audits[0]!.cloudId).toBe(CLOUD_A);
    expect(audits[0]!.pageIds).toEqual(["a", "b"]);
    expect(audits[0]!.maxOperations).toBe(2);
    expect(audits[0]!.outstanding).toBe(1);
    // Audit metadata never carries the token itself.
    expect((audits[0]! as unknown as Record<string, string>).token).toBeUndefined();
  });
});

// ===========================================================================
// Validate (and reservation)
// ===========================================================================

describe("validateBatchToken", () => {
  it("returns valid+reservationId on first matching call; decrements counter", async () => {
    const t = mintBatchToken({ cloudId: CLOUD_A, pageIds: ["p1", "p2"] });
    const r1 = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    expect(r1.valid).toBe(true);
    if (r1.valid) {
      expect(typeof r1.reservationId).toBe("string");
      expect(r1.reservationId.length).toBeGreaterThan(0);
    }
  });

  it("authorises multiple writes to the same page until the counter is exhausted", async () => {
    const t = mintBatchToken({
      cloudId: CLOUD_A,
      pageIds: ["p1"],
      maxOperations: 2,
    });
    const r1 = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    const r2 = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    const r3 = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    expect(r1.valid).toBe(true);
    expect(r2.valid).toBe(true);
    expect(r3.valid).toBe(false);
  });

  it("rejects unknown token bytes (returns invalid; audit outcome 'unknown')", async () => {
    const audits: BatchAuditValidateMeta[] = [];
    onValidateBatch((m) => audits.push(m));

    const result = await validateBatchToken({
      token: "btk_" + "0".repeat(64),
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    expect(result.valid).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.outcome).toBe("unknown");
    expect(audits[0]!.auditId).toBeUndefined();
  });

  it("rejects mismatched cloudId (returns invalid; audit outcome 'cloudid_mismatch')", async () => {
    const audits: BatchAuditValidateMeta[] = [];
    onValidateBatch((m) => audits.push(m));
    const t = mintBatchToken({ cloudId: CLOUD_A, pageIds: ["p1"] });

    const result = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_B,
      pageId: "p1",
    });
    expect(result.valid).toBe(false);
    expect(audits[0]!.outcome).toBe("cloudid_mismatch");
  });

  it("rejects unauthorised page_id (returns invalid; audit outcome 'page_id_not_authorised')", async () => {
    const audits: BatchAuditValidateMeta[] = [];
    onValidateBatch((m) => audits.push(m));
    const t = mintBatchToken({ cloudId: CLOUD_A, pageIds: ["p1"] });

    const result = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p-evil",
    });
    expect(result.valid).toBe(false);
    expect(audits[0]!.outcome).toBe("page_id_not_authorised");
  });

  it("rejects exhausted token (returns invalid; audit outcome 'exhausted')", async () => {
    const audits: BatchAuditValidateMeta[] = [];
    onValidateBatch((m) => audits.push(m));
    const t = mintBatchToken({
      cloudId: CLOUD_A,
      pageIds: ["p1"],
      maxOperations: 1,
    });
    await validateBatchToken({ token: t.token, cloudId: CLOUD_A, pageId: "p1" });
    const r2 = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    expect(r2.valid).toBe(false);
    const last = audits[audits.length - 1]!;
    expect(last.outcome).toBe("exhausted");
  });

  it("rejects expired token (lazy expiry on validate; audit outcome 'expired')", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T00:00:00Z"));

    const audits: BatchAuditValidateMeta[] = [];
    onValidateBatch((m) => audits.push(m));
    const t = mintBatchToken({
      cloudId: CLOUD_A,
      pageIds: ["p1"],
      ttlSeconds: 60,
    });
    // Advance just past TTL.
    vi.setSystemTime(new Date("2026-05-07T00:01:01Z"));

    const validateP = validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    // Drain the 5 ms validate floor.
    await vi.advanceTimersByTimeAsync(10);
    const result = await validateP;

    expect(result.valid).toBe(false);
    expect(audits[0]!.outcome).toBe("expired");
  });

  it("returned shape never leaks the granular failure reason (oracle resistance)", async () => {
    const t = mintBatchToken({ cloudId: CLOUD_A, pageIds: ["p1"] });

    const cases: Array<{ name: string; token: string; cloudId: string; pageId: string }> = [
      { name: "unknown", token: "btk_" + "0".repeat(64), cloudId: CLOUD_A, pageId: "p1" },
      { name: "cloudid_mismatch", token: t.token, cloudId: CLOUD_B, pageId: "p1" },
      { name: "page_id_not_authorised", token: t.token, cloudId: CLOUD_A, pageId: "x" },
    ];
    for (const c of cases) {
      const r = await validateBatchToken({
        token: c.token,
        cloudId: c.cloudId,
        pageId: c.pageId,
      });
      // Externally only `{ valid: false }` is observable.
      expect(r).toEqual({ valid: false });
    }
  });

  it("enforces a 5 ms minimum wall-clock floor on validate (timing-side-channel resistance)", async () => {
    const start = Date.now();
    await validateBatchToken({
      token: "btk_" + "0".repeat(64),
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(5);
  });
});

// ===========================================================================
// Refund / finalise
// ===========================================================================

describe("refundReservation", () => {
  it("refunds a valid reservation; counter goes back to its pre-reserve value", async () => {
    const t = mintBatchToken({
      cloudId: CLOUD_A,
      pageIds: ["p1"],
      maxOperations: 1,
    });
    const r = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    expect(r.valid).toBe(true);
    if (!r.valid) return;

    expect(refundReservation(r.reservationId)).toBe(true);

    // After refund, the slot is available again.
    const r2 = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    expect(r2.valid).toBe(true);
  });

  it("idempotent: a second refund call is a no-op (no double-increment)", async () => {
    const t = mintBatchToken({
      cloudId: CLOUD_A,
      pageIds: ["p1"],
      maxOperations: 1,
    });
    const r = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    if (!r.valid) throw new Error("unreachable");

    const refunds: BatchAuditRefundMeta[] = [];
    onRefundBatch((m) => refunds.push(m));

    expect(refundReservation(r.reservationId)).toBe(true);
    expect(refundReservation(r.reservationId)).toBe(false);

    // Even though two refund() calls were made, the counter is at 1
    // (the original allocation), not 2.
    const r2 = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    expect(r2.valid).toBe(true);
    if (!r2.valid) return;
    expect(refundReservation(r2.reservationId)).toBe(true);
    const r3 = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    expect(r3.valid).toBe(true);
    if (!r3.valid) return;
    // We've now done 3 reservations, refunded 2 (genuinely).
    // remainingOperations should be 0, the next validate exhausted.
    const r4 = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    expect(r4.valid).toBe(false);

    // Refund call sequence in this test:
    //  1) refundReservation(r)  → true  (genuine refund)
    //  2) refundReservation(r)  → false (idempotent no-op)
    //  3) refundReservation(r2) → true  (genuine refund)
    // r3 is never refunded. So 2 refunded=true events + 1 refunded=false.
    const events = refunds.filter((m) => m.pageId === "p1");
    const refundedCount = events.filter((m) => m.refunded).length;
    const noopCount = events.filter((m) => !m.refunded).length;
    expect(refundedCount).toBe(2);
    expect(noopCount).toBe(1);
  });

  it("returns false for an unknown reservationId", () => {
    expect(refundReservation("does-not-exist")).toBe(false);
  });

  it("returns false when the parent token has been evicted/expired", async () => {
    const t = mintBatchToken({
      cloudId: CLOUD_A,
      pageIds: ["p1"],
      maxOperations: 2,
      ttlSeconds: 60,
    });
    const r = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    if (!r.valid) throw new Error("unreachable");

    // Force-expire by validating after TTL.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 70_000);
    const validate = validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    await vi.advanceTimersByTimeAsync(10);
    await validate;
    vi.useRealTimers();

    expect(refundReservation(r.reservationId)).toBe(false);
  });
});

describe("finaliseReservation", () => {
  it("removes the reservation entry without touching the counter", async () => {
    const t = mintBatchToken({
      cloudId: CLOUD_A,
      pageIds: ["p1"],
      maxOperations: 1,
    });
    const r = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    if (!r.valid) throw new Error("unreachable");

    finaliseReservation(r.reservationId);
    // After finalise, refund is a no-op (reservation gone).
    expect(refundReservation(r.reservationId)).toBe(false);
    // And the counter remains at zero (still exhausted).
    const r2 = await validateBatchToken({
      token: t.token,
      cloudId: CLOUD_A,
      pageId: "p1",
    });
    expect(r2.valid).toBe(false);
  });
});

// ===========================================================================
// Mint rate limit
// ===========================================================================

describe("mint rate limit", () => {
  it("throws BatchMintRateLimitedError when the 15-min cap is hit", () => {
    process.env.EPIMETHIAN_BATCH_MINT_LIMIT = "3";
    mintBatchToken({ cloudId: CLOUD_A, pageIds: ["p1"] });
    mintBatchToken({ cloudId: CLOUD_A, pageIds: ["p2"] });
    mintBatchToken({ cloudId: CLOUD_A, pageIds: ["p3"] });

    expect(() =>
      mintBatchToken({ cloudId: CLOUD_A, pageIds: ["p4"] }),
    ).toThrow(BatchMintRateLimitedError);
  });

  it("exposes BATCH_MINT_RATE_LIMITED on the thrown error", () => {
    process.env.EPIMETHIAN_BATCH_MINT_LIMIT = "1";
    mintBatchToken({ cloudId: CLOUD_A, pageIds: ["p1"] });
    try {
      mintBatchToken({ cloudId: CLOUD_A, pageIds: ["p2"] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e instanceof BatchMintRateLimitedError).toBe(true);
      if (e instanceof BatchMintRateLimitedError) {
        expect(e.code).toBe(BATCH_MINT_RATE_LIMITED);
      }
    }
  });

  it("EPIMETHIAN_BATCH_MINT_LIMIT=0 disables the cap", () => {
    process.env.EPIMETHIAN_BATCH_MINT_LIMIT = "0";
    for (let i = 0; i < MAX_BATCH_MINTS_PER_15_MIN + 5; i++) {
      // mintBatchToken will FIFO-evict tokens but should not throw.
      mintBatchToken({ cloudId: CLOUD_A, pageIds: [`p${i}`] });
    }
  });
});

// ===========================================================================
// FIFO eviction
// ===========================================================================

describe("FIFO eviction", () => {
  it("evicts the oldest token when MAX_OUTSTANDING_BATCH_TOKENS is exceeded", () => {
    process.env.EPIMETHIAN_BATCH_MINT_LIMIT = "0";
    const tokens: string[] = [];
    for (let i = 0; i < MAX_OUTSTANDING_BATCH_TOKENS + 1; i++) {
      tokens.push(
        mintBatchToken({ cloudId: CLOUD_A, pageIds: [`p${i}`] }).token,
      );
    }

    // The oldest token (tokens[0]) should be evicted; using it in
    // validate returns invalid.
    return validateBatchToken({
      token: tokens[0]!,
      cloudId: CLOUD_A,
      pageId: "p0",
    }).then((r) => {
      expect(r.valid).toBe(false);
      // The newest token still works.
      return validateBatchToken({
        token: tokens[tokens.length - 1]!,
        cloudId: CLOUD_A,
        pageId: `p${MAX_OUTSTANDING_BATCH_TOKENS}`,
      });
    }).then((r2) => {
      expect(r2.valid).toBe(true);
    });
  });
});

// ===========================================================================
// Token shape
// ===========================================================================

describe("isBatchTokenShape", () => {
  it("accepts a freshly-minted token", () => {
    const t = mintBatchToken({ cloudId: CLOUD_A, pageIds: ["p1"] });
    expect(isBatchTokenShape(t.token)).toBe(true);
  });

  it("rejects strings without the btk_ prefix", () => {
    expect(isBatchTokenShape("a".repeat(68))).toBe(false);
    expect(isBatchTokenShape("conf_" + "a".repeat(64))).toBe(false);
  });

  it("rejects strings of the wrong length", () => {
    expect(isBatchTokenShape("btk_" + "a".repeat(63))).toBe(false);
    expect(isBatchTokenShape("btk_" + "a".repeat(65))).toBe(false);
  });

  it("rejects strings with non-hex bytes after the prefix", () => {
    expect(isBatchTokenShape("btk_" + "g".repeat(64))).toBe(false);
    expect(isBatchTokenShape("btk_" + "z".repeat(64))).toBe(false);
  });

  it("rejects non-string inputs without throwing", () => {
    // The function signature is `string` but the runtime guard exists.
    expect(isBatchTokenShape(undefined as unknown as string)).toBe(false);
    expect(isBatchTokenShape(null as unknown as string)).toBe(false);
    expect(isBatchTokenShape(42 as unknown as string)).toBe(false);
  });
});

// ===========================================================================
// Defaults
// ===========================================================================

describe("defaults", () => {
  it("DEFAULT_BATCH_TTL_SECONDS is 15 minutes (900s)", () => {
    expect(DEFAULT_BATCH_TTL_SECONDS).toBe(900);
  });

  it("default ttl is applied when ttl_seconds is omitted", () => {
    const before = Date.now();
    const t = mintBatchToken({ cloudId: CLOUD_A, pageIds: ["p1"] });
    expect(t.expiresAt - before).toBeGreaterThanOrEqual(900_000 - 50);
    expect(t.expiresAt - before).toBeLessThanOrEqual(900_000 + 50);
  });
});
