import { describe, expect, it } from "vitest";
import { isValidAccountId } from "./account-id-validator.js";

describe("isValidAccountId — valid formats", () => {
  it("accepts the modern 557058:UUID form (hyphenated)", () => {
    expect(
      isValidAccountId("557058:a0f1b2c3-d4e5-6789-abcd-ef0123456789")
    ).toBe(true);
  });

  it("accepts the modern form with non-standard but strict-charset suffix", () => {
    expect(
      isValidAccountId("712020:abc123def456-78901234-abcd-ef0123456789")
    ).toBe(true);
  });

  it("accepts a modern prefix of arbitrary numeric length", () => {
    expect(
      isValidAccountId("1:a0f1b2c3-d4e5-6789-abcd-ef0123456789")
    ).toBe(true);
  });

  it("accepts a legacy 5b-prefixed 24-char hex ID", () => {
    expect(isValidAccountId("5b10a0effa615349cbff8ae9")).toBe(true);
  });

  it("accepts legacy IDs starting with 5c, 5d, 5e, 5f", () => {
    expect(isValidAccountId("5c10a0effa615349cbff8ae9")).toBe(true);
    expect(isValidAccountId("5d10a0effa615349cbff8ae9")).toBe(true);
    expect(isValidAccountId("5e10a0effa615349cbff8ae9")).toBe(true);
    expect(isValidAccountId("5f10a0effa615349cbff8ae9")).toBe(true);
  });
});

describe("isValidAccountId — rejections", () => {
  it("rejects the empty string", () => {
    expect(isValidAccountId("")).toBe(false);
  });

  it("rejects oversized inputs (>200 chars)", () => {
    expect(isValidAccountId("1:" + "a".repeat(199))).toBe(false);
    expect(isValidAccountId("1:" + "a".repeat(200))).toBe(false);
  });

  it("rejects XML-special characters", () => {
    expect(isValidAccountId('557058:"><script>')).toBe(false);
    expect(isValidAccountId("557058:&amp;")).toBe(false);
    expect(isValidAccountId("557058:<evil/>")).toBe(false);
    expect(isValidAccountId("557058:'injected'")).toBe(false);
  });

  it("rejects control characters and null bytes", () => {
    expect(isValidAccountId("557058:a\u0000bc")).toBe(false);
    expect(isValidAccountId("557058:\ndead")).toBe(false);
    expect(isValidAccountId("557058:a\tb")).toBe(false);
  });

  it("rejects whitespace-padded values", () => {
    expect(isValidAccountId(" 5b10a0effa615349cbff8ae9")).toBe(false);
    expect(isValidAccountId("5b10a0effa615349cbff8ae9 ")).toBe(false);
  });

  it("rejects legacy IDs of the wrong length", () => {
    expect(isValidAccountId("5b10a0effa615349cbff8ae")).toBe(false); // 23
    expect(isValidAccountId("5b10a0effa615349cbff8ae90")).toBe(false); // 25
  });

  it("rejects legacy IDs with non-hex characters", () => {
    expect(isValidAccountId("5b10a0effa615349cbff8aez")).toBe(false);
  });

  it("rejects modern-form strings whose suffix is too short", () => {
    expect(isValidAccountId("557058:abcdef")).toBe(false);
  });

  it("rejects modern-form strings whose prefix is non-numeric", () => {
    expect(
      isValidAccountId("abc:a0f1b2c3-d4e5-6789-abcd-ef0123456789")
    ).toBe(false);
  });

  it("rejects strings missing the colon separator", () => {
    expect(isValidAccountId("557058a0f1b2c3-d4e5-6789-abcd-ef0123456789")).toBe(
      false
    );
  });

  it("rejects non-string inputs defensively", () => {
    // @ts-expect-error -- intentional runtime-safety assertion
    expect(isValidAccountId(null)).toBe(false);
    // @ts-expect-error -- intentional
    expect(isValidAccountId(undefined)).toBe(false);
    // @ts-expect-error -- intentional
    expect(isValidAccountId(557058)).toBe(false);
  });
});
