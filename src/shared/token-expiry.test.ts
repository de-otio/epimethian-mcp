import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  describeExpiry,
  isValidExpiryDate,
  todayUtc,
  tokenExpiryState,
} from "./token-expiry.js";

const TODAY = "2026-12-01";

describe("tokenExpiryState (frozen today)", () => {
  it.each([
    ["2026-12-16", "ok", 15],
    ["2026-12-15", "soon", 14],
    ["2026-12-01", "soon", 0],
    ["2026-11-30", "expired", -1],
  ] as const)("expiry %s is %s (%i days)", (expiry, kind, daysLeft) => {
    expect(tokenExpiryState(expiry, TODAY)).toEqual({ kind, daysLeft });
  });

  it("counts whole UTC days across a month and a leap-year boundary", () => {
    expect(tokenExpiryState("2028-03-01", "2028-02-28")).toEqual({ kind: "soon", daysLeft: 2 });
    expect(tokenExpiryState("2027-03-01", "2027-02-28")).toEqual({ kind: "soon", daysLeft: 1 });
  });

  it.each([undefined, "", "2026-1-5", "2026-02-30", "2026-13-01", "12/01/2026", "2026-12-01T00:00:00Z", "soon"])(
    "malformed or missing expiry %s is none",
    (expiry) => {
      expect(tokenExpiryState(expiry, TODAY)).toEqual({ kind: "none" });
    },
  );

  it("a malformed clock is none, never a false 'expired'", () => {
    expect(tokenExpiryState("2026-12-01", "yesterday")).toEqual({ kind: "none" });
  });

  it("property: the state is a pure function of the day difference", () => {
    fc.assert(
      fc.property(fc.integer({ min: -400, max: 800 }), (offset) => {
        const base = Date.UTC(2026, 11, 1);
        const expiry = new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
        const s = tokenExpiryState(expiry, TODAY);
        if (s.kind === "none") return false;
        const expected = offset < 0 ? "expired" : offset <= 14 ? "soon" : "ok";
        return s.daysLeft === offset && s.kind === expected;
      }),
      { seed: 760, numRuns: 300 },
    );
  });
});

describe("describeExpiry", () => {
  it("renders days left, today, and expired", () => {
    expect(describeExpiry("2026-12-16", tokenExpiryState("2026-12-16", TODAY))).toBe("2026-12-16 (15 days left)");
    expect(describeExpiry("2026-12-02", tokenExpiryState("2026-12-02", TODAY))).toBe("2026-12-02 (1 day left)");
    expect(describeExpiry("2026-12-01", tokenExpiryState("2026-12-01", TODAY))).toBe("2026-12-01 (expires today)");
    expect(describeExpiry("2026-11-30", tokenExpiryState("2026-11-30", TODAY))).toBe("EXPIRED on 2026-11-30 (1 day ago)");
  });
});

describe("isValidExpiryDate / todayUtc", () => {
  it("accepts real calendar dates only", () => {
    expect(isValidExpiryDate("2028-02-29")).toBe(true);
    expect(isValidExpiryDate("2027-02-29")).toBe(false);
    expect(isValidExpiryDate("2026-04-31")).toBe(false);
  });

  it("todayUtc is the UTC date, not the local one", () => {
    expect(todayUtc(new Date("2026-12-01T23:59:59Z"))).toBe("2026-12-01");
    expect(todayUtc(new Date("2026-12-02T00:00:00Z"))).toBe("2026-12-02");
  });
});
