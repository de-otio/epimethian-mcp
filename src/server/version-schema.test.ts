import { describe, it, expect } from "vitest";
import { versionField } from "./version-schema.js";

describe("versionField", () => {
  // --- Accepted: string-encoded positive integers (coercion path) ---

  it('accepts "6" and coerces to 6', () => {
    const result = versionField.safeParse("6");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(6);
  });

  it('accepts "007" and coerces to 7', () => {
    const result = versionField.safeParse("007");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(7);
  });

  // --- Accepted: bare positive integer (no coercion needed) ---

  it("accepts integer 6 directly", () => {
    const result = versionField.safeParse(6);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(6);
  });

  // --- Accepted: the "current" literal ---

  it('accepts the string literal "current"', () => {
    const result = versionField.safeParse("current");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("current");
  });

  // --- Rejected: invalid strings ---

  it('rejects empty string ""', () => {
    const result = versionField.safeParse("");
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-padded string " 6 "', () => {
    const result = versionField.safeParse(" 6 ");
    expect(result.success).toBe(false);
  });

  it('rejects decimal string "6.0"', () => {
    const result = versionField.safeParse("6.0");
    expect(result.success).toBe(false);
  });

  it('rejects negative string "-6"', () => {
    const result = versionField.safeParse("-6");
    expect(result.success).toBe(false);
  });

  it('rejects string "current2" (no branch matches)', () => {
    const result = versionField.safeParse("current2");
    expect(result.success).toBe(false);
  });

  // --- Rejected: invalid numbers ---

  it("rejects zero (0)", () => {
    const result = versionField.safeParse(0);
    expect(result.success).toBe(false);
  });

  it("rejects negative integer (-1)", () => {
    const result = versionField.safeParse(-1);
    expect(result.success).toBe(false);
  });

  it("rejects non-integer float (6.5)", () => {
    const result = versionField.safeParse(6.5);
    expect(result.success).toBe(false);
  });
});
