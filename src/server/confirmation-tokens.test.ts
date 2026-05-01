/**
 * Tests for the confirmation-token store (Phase 2 / v6.6.0).
 *
 * Mandatory test list per plan §5.2 — every `it(...)` description below
 * mirrors a bullet in the plan so a reviewer can map them 1:1.
 *
 * Audit-outcome convention for evicted tokens (plan §3.2 note 6 — choice
 * documented here): when a FIFO eviction happens DURING mint, an
 * `onValidate` event with `outcome: "evicted"` fires immediately for the
 * evicted token. A subsequent attempt to validate that token then sees
 * `outcome: "unknown"` (the token is no longer in the store), as the
 * plan's resource/abuse-cap bullet specifies.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  type AuditMintMeta,
  type AuditValidateMeta,
  type ConfirmationContext,
  DEFAULT_SOFT_CONFIRM_TTL_MS,
  MAX_MINTS_PER_15_MIN,
  MAX_OUTSTANDING_TOKENS,
  SOFT_CONFIRM_RATE_LIMITED,
  SoftConfirmRateLimitedError,
  _resetForTest,
  computeDiffHash,
  invalidateForPage,
  mintToken,
  onMint,
  onValidate,
  validateToken,
} from "./confirmation-tokens.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ctx(overrides: Partial<ConfirmationContext> = {}): ConfirmationContext {
  return {
    tool: "update_page",
    cloudId: "cloud-A",
    pageId: "page-1",
    pageVersion: 7,
    diffHash: computeDiffHash("<storage/>", 7),
    ...overrides,
  };
}

beforeEach(() => {
  _resetForTest();
  delete process.env.EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT;
  delete process.env.EPIMETHIAN_SOFT_CONFIRM_TTL_MS;
});

afterEach(() => {
  vi.useRealTimers();
  _resetForTest();
  delete process.env.EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT;
  delete process.env.EPIMETHIAN_SOFT_CONFIRM_TTL_MS;
});

// ===========================================================================
// External-API tests
// ===========================================================================

describe("confirmation-tokens — external API", () => {
  it("mint then validate immediately returns 'ok'; second validate is 'invalid' (single-use)", async () => {
    const c = ctx();
    const t = mintToken(c);

    const audits: AuditValidateMeta[] = [];
    onValidate((m) => audits.push(m));

    expect(await validateToken(t.token, c)).toBe("ok");
    expect(await validateToken(t.token, c)).toBe("invalid");

    expect(audits[0]?.outcome).toBe("ok");
    expect(audits[1]?.outcome).toBe("unknown");
  });

  it("cloudId mismatch returns 'invalid' (audit shows 'mismatch') — multi-tenant guard", async () => {
    const t = mintToken(ctx({ cloudId: "abc" }));

    const seen: AuditValidateMeta[] = [];
    onValidate((m) => seen.push(m));

    expect(await validateToken(t.token, ctx({ cloudId: "xyz" }))).toBe("invalid");
    expect(seen[0]?.outcome).toBe("mismatch");
  });

  it("tool mismatch returns 'invalid' (audit shows 'mismatch')", async () => {
    const t = mintToken(ctx({ tool: "update_page" }));

    const seen: AuditValidateMeta[] = [];
    onValidate((m) => seen.push(m));

    expect(await validateToken(t.token, ctx({ tool: "delete_page" }))).toBe("invalid");
    expect(seen[0]?.outcome).toBe("mismatch");
  });

  it("pageId mismatch returns 'invalid' (audit shows 'mismatch')", async () => {
    const t = mintToken(ctx({ pageId: "1" }));

    const seen: AuditValidateMeta[] = [];
    onValidate((m) => seen.push(m));

    expect(await validateToken(t.token, ctx({ pageId: "2" }))).toBe("invalid");
    expect(seen[0]?.outcome).toBe("mismatch");
  });

  it("pageVersion mismatch returns 'invalid' (audit shows 'mismatch')", async () => {
    const t = mintToken(ctx({ pageVersion: 7 }));

    const seen: AuditValidateMeta[] = [];
    onValidate((m) => seen.push(m));

    expect(await validateToken(t.token, ctx({ pageVersion: 8 }))).toBe("invalid");
    expect(seen[0]?.outcome).toBe("mismatch");
  });

  it("diffHash mismatch returns 'invalid' (audit shows 'mismatch')", async () => {
    const t = mintToken(ctx({ diffHash: "AAA" }));

    const seen: AuditValidateMeta[] = [];
    onValidate((m) => seen.push(m));

    expect(await validateToken(t.token, ctx({ diffHash: "BBB" }))).toBe("invalid");
    expect(seen[0]?.outcome).toBe("mismatch");
  });

  it("expired token returns 'invalid' (audit shows 'expired')", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const c = ctx();
    // Mint with default TTL (5 min). Advance past it.
    const t = mintToken(c);

    const seen: AuditValidateMeta[] = [];
    onValidate((m) => seen.push(m));

    vi.setSystemTime(t.expiresAt + 1);

    // The validate floor uses setTimeout — advance fake timers while we
    // await the promise to let the floor's sleep resolve.
    const p = validateToken(t.token, c);
    await vi.advanceTimersByTimeAsync(20);
    expect(await p).toBe("invalid");
    expect(seen[0]?.outcome).toBe("expired");
  });

  it("invalidateForPage marks all outstanding tokens for that page as 'stale'", async () => {
    const c = ctx({ cloudId: "cloud-A", pageId: "page-X" });
    const t = mintToken(c);

    const seen: AuditValidateMeta[] = [];
    onValidate((m) => seen.push(m));

    invalidateForPage(c.cloudId, c.pageId);
    // The invalidation itself fires an audit event with outcome "stale"
    // for each victim.
    expect(seen.some((m) => m.outcome === "stale" && m.auditId === t.auditId)).toBe(true);

    // The token now validates as "invalid" (audit event at validate-time
    // is "unknown" since the entry has already been removed).
    seen.length = 0;
    expect(await validateToken(t.token, c)).toBe("invalid");
    expect(seen[0]?.outcome).toBe("unknown");
  });

  it("validating a never-minted token returns 'invalid' (audit shows 'unknown')", async () => {
    const seen: AuditValidateMeta[] = [];
    onValidate((m) => seen.push(m));

    expect(await validateToken("never-minted-token-xyz", ctx())).toBe("invalid");
    expect(seen[0]?.outcome).toBe("unknown");
    expect(seen[0]?.auditId).toBeUndefined();
  });

  it("TOCTOU: validate of T1 succeeds and atomically marks sibling T2 (same page) as 'invalid'/'stale'", async () => {
    const cBase = ctx({ cloudId: "cloud-A", pageId: "page-Z" });
    const c1 = { ...cBase, diffHash: computeDiffHash("<a/>", cBase.pageVersion) };
    const c2 = { ...cBase, diffHash: computeDiffHash("<b/>", cBase.pageVersion) };

    const t1 = mintToken(c1);
    const t2 = mintToken(c2);

    const seen: AuditValidateMeta[] = [];
    onValidate((m) => seen.push(m));

    expect(await validateToken(t1.token, c1)).toBe("ok");
    // Among the audit events that fired during the validate, one was
    // outcome "ok" (for t1) and one was outcome "stale" (for t2's
    // sibling-invalidation). Order: stale fires before the final "ok"
    // record in the implementation.
    const okEv = seen.find((m) => m.outcome === "ok");
    const staleEv = seen.find(
      (m) => m.outcome === "stale" && m.auditId === t2.auditId,
    );
    expect(okEv).toBeDefined();
    expect(staleEv).toBeDefined();

    // Now the second token validates as invalid; the entry was removed,
    // so the validate-time outcome is "unknown".
    seen.length = 0;
    expect(await validateToken(t2.token, c2)).toBe("invalid");
    expect(seen.find((m) => m.tool === c2.tool)?.outcome).toBe("unknown");
  });
});

// ===========================================================================
// Resource / abuse-cap tests
// ===========================================================================

describe("confirmation-tokens — resource caps", () => {
  it("51st mint after 50 outstanding FIFO-evicts the oldest; evicted token's later validate is 'invalid' (audit 'unknown')", async () => {
    const c = ctx();
    const evictionEvents: AuditValidateMeta[] = [];
    onValidate((m) => {
      if (m.outcome === "evicted") evictionEvents.push(m);
    });

    const tokens: string[] = [];
    for (let i = 0; i < MAX_OUTSTANDING_TOKENS; i++) {
      tokens.push(mintToken({ ...c, pageId: `p-${i}` }).token);
    }
    expect(evictionEvents.length).toBe(0);

    // The 51st mint evicts the oldest (tokens[0]).
    mintToken({ ...c, pageId: "p-overflow" });
    expect(evictionEvents.length).toBe(1);
    expect(evictionEvents[0]?.pageId).toBe("p-0");

    // The evicted token's subsequent validate is "invalid" — the audit
    // outcome at validate-time is "unknown" (entry no longer in the
    // store). This is the §5.2 "evicted token's subsequent validate"
    // assertion.
    const validates: AuditValidateMeta[] = [];
    onValidate((m) => {
      if (m.outcome !== "evicted") validates.push(m);
    });
    expect(
      await validateToken(tokens[0]!, { ...c, pageId: "p-0" }),
    ).toBe("invalid");
    expect(validates[0]?.outcome).toBe("unknown");
  });

  it("101st mintToken within 15 min throws SOFT_CONFIRM_RATE_LIMITED; advancing time past 15 min restores capacity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const c = ctx();
    for (let i = 0; i < MAX_MINTS_PER_15_MIN; i++) {
      mintToken({ ...c, pageId: `p-${i}` });
    }

    expect(() => mintToken({ ...c, pageId: "overflow" })).toThrow(
      SoftConfirmRateLimitedError,
    );
    // Confirm the error code matches the constant.
    try {
      mintToken({ ...c, pageId: "overflow-2" });
    } catch (e) {
      expect((e as SoftConfirmRateLimitedError).code).toBe(SOFT_CONFIRM_RATE_LIMITED);
    }

    // Advance just past the 15-min window: a fresh mint succeeds.
    vi.setSystemTime(15 * 60 * 1000 + 1);
    expect(() => mintToken({ ...c, pageId: "after-window" })).not.toThrow();
  });

  it("EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT='0' disables the rate cap (1000 mints succeed)", () => {
    process.env.EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT = "0";
    const c = ctx();
    expect(() => {
      for (let i = 0; i < 1000; i++) mintToken({ ...c, pageId: `p-${i}` });
    }).not.toThrow();
    // Store remains bounded by FIFO eviction at MAX_OUTSTANDING_TOKENS.
  });

  it("EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT='200' lifts the rate cap to 200 / 15 min", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    process.env.EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT = "200";

    const c = ctx();
    expect(() => {
      for (let i = 0; i < 200; i++) mintToken({ ...c, pageId: `p-${i}` });
    }).not.toThrow();
    expect(() => mintToken({ ...c, pageId: "201" })).toThrow(
      SoftConfirmRateLimitedError,
    );
  });

  it("TTL clamp (programmatic): ttlMs=10_000 clamps up to 60 s; ttlMs=99_999_999_999 clamps down to 900 s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const tLow = mintToken(ctx(), 10_000);
    expect(tLow.expiresAt).toBe(60_000);

    _resetForTest();
    vi.setSystemTime(0);

    const tHigh = mintToken(ctx(), 99_999_999_999);
    expect(tHigh.expiresAt).toBe(900_000);
  });

  it("TTL clamp (env var): EPIMETHIAN_SOFT_CONFIRM_TTL_MS=10000 clamps up to 60 s; over-ceiling clamps down to 900 s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    process.env.EPIMETHIAN_SOFT_CONFIRM_TTL_MS = "10000";
    const tLow = mintToken(ctx());
    expect(tLow.expiresAt).toBe(60_000);

    _resetForTest();
    vi.setSystemTime(0);

    process.env.EPIMETHIAN_SOFT_CONFIRM_TTL_MS = "99999999999";
    const tHigh = mintToken(ctx());
    expect(tHigh.expiresAt).toBe(900_000);

    _resetForTest();
    vi.setSystemTime(0);

    // Sanity: with no env, the default applies (and is itself in-range).
    delete process.env.EPIMETHIAN_SOFT_CONFIRM_TTL_MS;
    const tDefault = mintToken(ctx());
    expect(tDefault.expiresAt).toBe(DEFAULT_SOFT_CONFIRM_TTL_MS);
  });
});

// ===========================================================================
// Timing-floor test (5 ms wall-clock minimum on validate)
// ===========================================================================

describe("confirmation-tokens — timing floor", () => {
  it("validate hit-path and miss-path differ by < 1 ms on average over 100 iterations (proves the 5 ms floor)", async () => {
    // Use REAL timers — this test measures wall-clock via performance.now().
    const c = ctx();
    const ITER = 100;

    // Hit path: re-mint each iteration so we always have a valid token.
    let totalHitMs = 0;
    for (let i = 0; i < ITER; i++) {
      const t = mintToken({ ...c, pageId: `hit-${i}` });
      const start = performance.now();
      const r = await validateToken(t.token, { ...c, pageId: `hit-${i}` });
      totalHitMs += performance.now() - start;
      expect(r).toBe("ok");
    }

    // Miss path: token never minted.
    let totalMissMs = 0;
    for (let i = 0; i < ITER; i++) {
      const start = performance.now();
      const r = await validateToken(`never-minted-${i}-aaaaaaaaaaaaaaaaaaaa`, c);
      totalMissMs += performance.now() - start;
      expect(r).toBe("invalid");
    }

    const avgHit = totalHitMs / ITER;
    const avgMiss = totalMissMs / ITER;

    // Both averages must be at least the floor (5 ms), and they must be
    // close to each other. We allow < 1 ms difference per the plan.
    expect(avgHit).toBeGreaterThanOrEqual(4.5); // tiny scheduler slack
    expect(avgMiss).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(avgHit - avgMiss)).toBeLessThan(1);
  });
});

// ===========================================================================
// Audit-hook tests
// ===========================================================================

describe("confirmation-tokens — audit hooks", () => {
  it("onMint fires exactly once per mintToken call with full metadata; payload NEVER contains the token", () => {
    const events: AuditMintMeta[] = [];
    onMint((m) => events.push(m));

    const c = ctx();
    const t1 = mintToken(c);
    const t2 = mintToken({ ...c, pageId: "page-2" });

    expect(events.length).toBe(2);

    expect(events[0]).toMatchObject({
      auditId: t1.auditId,
      tool: c.tool,
      cloudId: c.cloudId,
      pageId: c.pageId,
      pageVersion: c.pageVersion,
      expiresAt: t1.expiresAt,
      outstanding: 1,
    });
    expect(events[1]?.outstanding).toBe(2);

    // Token must not appear anywhere in the audit payload — serialise
    // and grep.
    const blob = JSON.stringify(events);
    expect(blob.includes(t1.token)).toBe(false);
    expect(blob.includes(t2.token)).toBe(false);
  });

  it("onValidate fires exactly once per validateToken call with the actual fine-grained outcome and the original auditId; payload NEVER contains the token", async () => {
    const events: AuditValidateMeta[] = [];
    onValidate((m) => events.push(m));

    const c = ctx();
    const t = mintToken(c);

    expect(await validateToken(t.token, c)).toBe("ok");
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      auditId: t.auditId,
      tool: c.tool,
      cloudId: c.cloudId,
      pageId: c.pageId,
      outcome: "ok",
    });

    // Replay → unknown (single-use; token consumed).
    expect(await validateToken(t.token, c)).toBe("invalid");
    expect(events.length).toBe(2);
    expect(events[1]?.outcome).toBe("unknown");
    expect(events[1]?.auditId).toBeUndefined();

    // Mismatch path.
    const t2 = mintToken(c);
    expect(await validateToken(t2.token, ctx({ tool: "other_tool" }))).toBe("invalid");
    const last = events.at(-1)!;
    expect(last.outcome).toBe("mismatch");
    expect(last.auditId).toBe(t2.auditId);

    const blob = JSON.stringify(events);
    expect(blob.includes(t.token)).toBe(false);
    expect(blob.includes(t2.token)).toBe(false);
  });
});

// ===========================================================================
// Memory & cleanliness
// ===========================================================================

describe("confirmation-tokens — memory & cleanliness", () => {
  it("1000 mints + 1000 validates leaves the outstanding map empty (or <= MAX_OUTSTANDING_TOKENS); no leaked entries", async () => {
    process.env.EPIMETHIAN_SOFT_CONFIRM_MINT_LIMIT = "0"; // disable rate cap
    const c = ctx();

    // We track outstanding via the audit hook (no public introspection
    // API by design — §3.2 note 9).
    let outstanding = 0;
    onMint((m) => {
      outstanding = m.outstanding;
    });

    const tokens: Array<{ token: string; pageId: string }> = [];
    for (let i = 0; i < 1000; i++) {
      const pid = `p-${i}`;
      const t = mintToken({ ...c, pageId: pid });
      tokens.push({ token: t.token, pageId: pid });
    }
    // Outstanding never exceeds the FIFO cap.
    expect(outstanding).toBeLessThanOrEqual(MAX_OUTSTANDING_TOKENS);

    // Validate all 1000 in parallel — the 5 ms floor would otherwise
    // serialise this into >5 s of wall time. Parallel execution keeps
    // the test under 1 s while still exercising every code path.
    await Promise.all(
      tokens.map(({ token, pageId }) =>
        validateToken(token, { ...c, pageId }),
      ),
    );

    // After all validates, mint one more and observe outstanding — it
    // should be exactly 1 (proves the prior ones were drained).
    const probe = mintToken({ ...c, pageId: "probe" });
    expect(outstanding).toBe(1);
    expect(await validateToken(probe.token, { ...c, pageId: "probe" })).toBe("ok");
  }, 15_000);

  it("_resetForTest clears all internal state (store, mint timestamps, audit handlers)", async () => {
    let mintCount = 0;
    onMint(() => {
      mintCount++;
    });
    mintToken(ctx());
    expect(mintCount).toBe(1);

    _resetForTest();

    // Hooks were cleared — minting again must NOT increment our counter.
    mintToken(ctx());
    expect(mintCount).toBe(1);

    // Confirm the rolling-mint window was also reset: after the reset
    // we re-mint up to the cap; the cap-plus-one mint throws. This
    // proves the timestamps array (not just the store) was cleared.
    _resetForTest();
    const c = ctx();
    for (let i = 0; i < MAX_MINTS_PER_15_MIN; i++) {
      mintToken({ ...c, pageId: `r-${i}` });
    }
    expect(() => mintToken({ ...c, pageId: "over" })).toThrow(SoftConfirmRateLimitedError);
  });
});

// ===========================================================================
// computeDiffHash determinism (shared with 2.B and 2.C — defensive coverage)
// ===========================================================================

describe("computeDiffHash", () => {
  it("is deterministic and sensitive to both XML bytes and pageVersion", () => {
    const a = computeDiffHash("<x/>", 1);
    const b = computeDiffHash("<x/>", 1);
    const c = computeDiffHash("<x />", 1);
    const d = computeDiffHash("<x/>", 2);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    // Hex SHA-256 is 64 chars.
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ===========================================================================
// Defensive coverage — audit handler isolation
// ===========================================================================

describe("confirmation-tokens — audit handler isolation", () => {
  it("a throwing onMint handler does NOT break minting; subsequent handlers still fire", () => {
    const events: AuditMintMeta[] = [];
    onMint(() => {
      throw new Error("boom — broken subscriber");
    });
    onMint((m) => events.push(m));

    const t = mintToken(ctx());
    expect(t.token).toBeTruthy();
    expect(events.length).toBe(1);
  });

  it("a throwing onValidate handler does NOT break validation; subsequent handlers still fire", async () => {
    const events: AuditValidateMeta[] = [];
    onValidate(() => {
      throw new Error("boom — broken subscriber");
    });
    onValidate((m) => events.push(m));

    const c = ctx();
    const t = mintToken(c);
    expect(await validateToken(t.token, c)).toBe("ok");
    expect(events.length).toBe(1);
    expect(events[0]?.outcome).toBe("ok");
  });
});
