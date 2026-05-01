import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetSessionCanaryForTest,
  detectUntrustedFenceInWrite,
  getSessionCanary,
} from "./session-canary.js";

describe("getSessionCanary (D3)", () => {
  beforeEach(() => {
    _resetSessionCanaryForTest();
  });

  it("generates a canary in the expected shape", () => {
    const c = getSessionCanary();
    // "EPI-" + UUID v4 form.
    expect(c).toMatch(/^EPI-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("is idempotent within the same process", () => {
    const a = getSessionCanary();
    const b = getSessionCanary();
    expect(a).toBe(b);
  });

  it("generates a fresh value after _resetSessionCanaryForTest (testing only)", () => {
    const first = getSessionCanary();
    _resetSessionCanaryForTest();
    const second = getSessionCanary();
    expect(first).not.toBe(second);
  });
});

describe("detectUntrustedFenceInWrite (D3)", () => {
  beforeEach(() => {
    _resetSessionCanaryForTest();
  });

  it("returns undefined for a clean body", () => {
    expect(
      detectUntrustedFenceInWrite("<p>no fence markers here</p>"),
    ).toBeUndefined();
  });

  it("detects the open-fence prefix", () => {
    expect(
      detectUntrustedFenceInWrite(
        "body\n<<<CONFLUENCE_UNTRUSTED pageId=1 field=body>>>\n",
      ),
    ).toBe("<<<CONFLUENCE_UNTRUSTED");
  });

  it("detects the close-fence marker", () => {
    expect(
      detectUntrustedFenceInWrite("body\n<<<END_CONFLUENCE_UNTRUSTED>>>\n"),
    ).toBe("<<<END_CONFLUENCE_UNTRUSTED>>>");
  });

  it("detects the current session canary", () => {
    const canary = getSessionCanary();
    const marker = detectUntrustedFenceInWrite(`body ${canary} tail`);
    expect(marker).toBe(canary);
  });

  it("open-fence detection short-circuits before the canary check (returns the more-specific marker)", () => {
    // If BOTH the fence and the canary appear, report the fence — it's the
    // more informative marker for the caller.
    const canary = getSessionCanary();
    const body = `<<<CONFLUENCE_UNTRUSTED foo=bar>>> ${canary}`;
    expect(detectUntrustedFenceInWrite(body)).toBe("<<<CONFLUENCE_UNTRUSTED");
  });
});
