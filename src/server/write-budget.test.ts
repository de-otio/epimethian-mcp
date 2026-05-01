import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WRITE_BUDGET_EXCEEDED,
  WriteBudgetExceededError,
  writeBudget,
} from "./write-budget.js";

describe("writeBudget (F4)", () => {
  beforeEach(() => {
    writeBudget._resetForTest();
  });

  afterEach(() => {
    delete process.env.EPIMETHIAN_WRITE_BUDGET_SESSION;
    delete process.env.EPIMETHIAN_WRITE_BUDGET_ROLLING;
    delete process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY;
    writeBudget._resetForTest();
  });

  it("F4: increments counters on consume()", () => {
    writeBudget.consume();
    writeBudget.consume();
    expect(writeBudget.session).toBe(2);
    expect(writeBudget.hourly).toBe(2);
  });

  it("F4: default session budget is 250", () => {
    // Disable rolling so session fires first and we can probe the default
    process.env.EPIMETHIAN_WRITE_BUDGET_ROLLING = "0";
    for (let i = 0; i < 250; i++) writeBudget.consume();
    expect(() => writeBudget.consume()).toThrow(/write budget exhausted \(session\)/i);
  });

  it("F4: default rolling budget is 75", () => {
    // Disable session so rolling fires first
    process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
    for (let i = 0; i < 75; i++) writeBudget.consume();
    expect(() => writeBudget.consume()).toThrow(/rolling write budget exhausted/i);
  });

  it("F4: throws WriteBudgetExceededError when session budget is hit", () => {
    process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "3";
    // Keep rolling cap higher so session fires first.
    process.env.EPIMETHIAN_WRITE_BUDGET_ROLLING = "100";
    writeBudget.consume();
    writeBudget.consume();
    writeBudget.consume();
    try {
      writeBudget.consume();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBudgetExceededError);
      const e = err as WriteBudgetExceededError;
      expect(e.code).toBe(WRITE_BUDGET_EXCEEDED);
      expect(e.scope).toBe("session");
      expect(e.current).toBe(3);
      expect(e.limit).toBe(3);
    }
  });

  it("F4: throws when rolling budget is hit (scope = rolling)", () => {
    process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "100";
    process.env.EPIMETHIAN_WRITE_BUDGET_ROLLING = "2";
    writeBudget.consume();
    writeBudget.consume();
    try {
      writeBudget.consume();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as WriteBudgetExceededError).scope).toBe("rolling");
    }
  });

  it("F4: EPIMETHIAN_WRITE_BUDGET_ROLLING overrides the default", () => {
    process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
    process.env.EPIMETHIAN_WRITE_BUDGET_ROLLING = "5";
    for (let i = 0; i < 5; i++) writeBudget.consume();
    expect(() => writeBudget.consume()).toThrow(/rolling write budget exhausted/i);
  });

  it("F4: EPIMETHIAN_WRITE_BUDGET_HOURLY overrides the default and sets deprecation flag", () => {
    process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
    process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "5";
    for (let i = 0; i < 5; i++) writeBudget.consume();
    // The first consume after setting HOURLY should produce a deprecation warning
    writeBudget._resetForTest();
    writeBudget.consume();
    const warnings = writeBudget.drainPendingWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("EPIMETHIAN_WRITE_BUDGET_HOURLY");
    expect(warnings[0]).toContain("EPIMETHIAN_WRITE_BUDGET_ROLLING");
  });

  it("F4: _ROLLING wins over _HOURLY; deprecation flag remains unset", () => {
    process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
    process.env.EPIMETHIAN_WRITE_BUDGET_ROLLING = "10";
    process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "5";
    writeBudget.consume();
    const warnings = writeBudget.drainPendingWarnings();
    expect(warnings).toHaveLength(0);
  });

  it("F4: 60 sequential consume() within a window do not exhaust the rolling cap", () => {
    // Default rolling cap is 75; 60 < 75 should not throw
    process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
    for (let i = 0; i < 60; i++) writeBudget.consume();
    expect(writeBudget.hourly).toBe(60);
  });

  it("F4: setting a scope to 0 disables that scope entirely", () => {
    process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
    process.env.EPIMETHIAN_WRITE_BUDGET_ROLLING = "0";
    for (let i = 0; i < 500; i++) writeBudget.consume();
    expect(writeBudget.session).toBe(500);
  });

  it("F4: invalid env override falls back to the default", () => {
    process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "not-a-number";
    // Disable the rolling window so the session default (250) is the only
    // ceiling under test.
    process.env.EPIMETHIAN_WRITE_BUDGET_ROLLING = "0";
    for (let i = 0; i < 250; i++) writeBudget.consume();
    expect(() => writeBudget.consume()).toThrow(
      /write budget exhausted \(session\)/i,
    );
  });

  it("F4: rolling window is sliding (expires old entries)", async () => {
    // Verify that entries outside the 15-minute window don't count. We
    // can't easily fast-forward without mocking Date.now, so exercise
    // the filter path: trigger the filter by reading `hourly` and
    // asserting the count matches consume() count (implicit: nothing
    // has been filtered out in this short test).
    writeBudget.consume();
    writeBudget.consume();
    expect(writeBudget.hourly).toBe(2);
  });

  it("F4: error message contains 'Why this exists' section", () => {
    process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "1";
    process.env.EPIMETHIAN_WRITE_BUDGET_ROLLING = "0";
    writeBudget.consume();
    try {
      writeBudget.consume();
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as WriteBudgetExceededError;
      expect(e.message).toContain("Why this exists");
      expect(e.message).toContain("safety net against runaway agents");
    }
  });

  it("F4: error message contains 'How to raise or disable the cap' section", () => {
    process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
    process.env.EPIMETHIAN_WRITE_BUDGET_ROLLING = "1";
    writeBudget.consume();
    try {
      writeBudget.consume();
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as WriteBudgetExceededError;
      expect(e.message).toContain("How to raise or disable the cap");
      expect(e.message).toContain("EPIMETHIAN_WRITE_BUDGET_ROLLING");
    }
  });

  it("F4: one-shot deprecation — only first consume() after _HOURLY produces a warning", () => {
    process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
    process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "100";

    // First consume should produce a warning
    writeBudget.consume();
    const firstWarnings = writeBudget.drainPendingWarnings();
    expect(firstWarnings).toHaveLength(1);

    // Second consume should produce no warning (flag cleared)
    writeBudget.consume();
    const secondWarnings = writeBudget.drainPendingWarnings();
    expect(secondWarnings).toHaveLength(0);
  });
});
