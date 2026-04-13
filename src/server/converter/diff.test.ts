import { describe, expect, it } from "vitest";
import { diffTokens } from "./diff.js";
import type { TokenSidecar } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a sidecar from a set of IDs; element values don't matter for diff. */
function sidecarFor(...ids: string[]): TokenSidecar {
  const s: TokenSidecar = {};
  for (const id of ids) s[id] = `<ac:x ac:id="${id}"/>`;
  return s;
}

/** Wrap a token ID in the literal form emitted by the tokeniser. */
function tok(id: string): string {
  return `[[epi:${id}]]`;
}

// ---------------------------------------------------------------------------
// Empty / trivial inputs
// ---------------------------------------------------------------------------

describe("diffTokens — empty and trivial", () => {
  it("empty canonical and empty caller → empty buckets", () => {
    const d = diffTokens("", "", {});
    expect(d).toEqual({ preserved: [], deleted: [], reordered: [], invented: [] });
  });

  it("no tokens in either (plain text) → empty buckets", () => {
    const d = diffTokens("just some text", "also just text", sidecarFor("T0001"));
    expect(d).toEqual({ preserved: [], deleted: [], reordered: [], invented: [] });
  });

  it("tokens in canonical but caller is empty → all deleted", () => {
    const canonical = `a ${tok("T0001")} b ${tok("T0002")}`;
    const d = diffTokens(canonical, "", sidecarFor("T0001", "T0002"));
    expect(d.preserved).toEqual([]);
    expect(d.deleted).toEqual(["T0001", "T0002"]);
    expect(d.reordered).toEqual([]);
    expect(d.invented).toEqual([]);
  });

  it("tokens in caller but canonical is empty and sidecar empty → all invented", () => {
    const caller = `${tok("T9999")}`;
    const d = diffTokens("", caller, {});
    expect(d.preserved).toEqual([]);
    expect(d.deleted).toEqual([]);
    expect(d.invented).toEqual(["T9999"]);
  });
});

// ---------------------------------------------------------------------------
// Preservation
// ---------------------------------------------------------------------------

describe("diffTokens — preservation", () => {
  it("caller matches canonical exactly → all preserved, none deleted/reordered/invented", () => {
    const canonical = `a ${tok("T0001")} b ${tok("T0002")} c`;
    const caller = canonical;
    const d = diffTokens(canonical, caller, sidecarFor("T0001", "T0002"));
    expect(d.preserved).toEqual(["T0001", "T0002"]);
    expect(d.deleted).toEqual([]);
    expect(d.reordered).toEqual([]);
    expect(d.invented).toEqual([]);
  });

  it("preserved order is canonical's first-occurrence order", () => {
    const canonical = `${tok("T0003")} ${tok("T0001")} ${tok("T0002")}`;
    const caller = canonical;
    const d = diffTokens(canonical, caller, sidecarFor("T0001", "T0002", "T0003"));
    expect(d.preserved).toEqual(["T0003", "T0001", "T0002"]);
  });

  it("duplicate token references in caller → single entry in preserved", () => {
    // Stream 3's restore explicitly allows multi-reference; we must not
    // double-count.
    const canonical = `${tok("T0001")}`;
    const caller = `${tok("T0001")} and again ${tok("T0001")}`;
    const d = diffTokens(canonical, caller, sidecarFor("T0001"));
    expect(d.preserved).toEqual(["T0001"]);
    expect(d.deleted).toEqual([]);
    expect(d.reordered).toEqual([]);
  });

  it("duplicate references in canonical → also collapsed in deleted bucket", () => {
    const canonical = `${tok("T0001")} and ${tok("T0001")}`;
    const caller = ""; // caller dropped it
    const d = diffTokens(canonical, caller, sidecarFor("T0001"));
    expect(d.deleted).toEqual(["T0001"]);
  });
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

describe("diffTokens — deletion", () => {
  it("caller omits some canonical tokens → those go to deleted", () => {
    const canonical = `${tok("T0001")} ${tok("T0002")} ${tok("T0003")}`;
    const caller = `${tok("T0001")} ${tok("T0003")}`; // dropped T0002
    const d = diffTokens(canonical, caller, sidecarFor("T0001", "T0002", "T0003"));
    expect(d.preserved).toEqual(["T0001", "T0003"]);
    expect(d.deleted).toEqual(["T0002"]);
    expect(d.reordered).toEqual([]);
    expect(d.invented).toEqual([]);
  });

  it("caller omits all canonical tokens → all deleted", () => {
    const canonical = `${tok("T0001")} ${tok("T0002")}`;
    const caller = `no tokens here`;
    const d = diffTokens(canonical, caller, sidecarFor("T0001", "T0002"));
    expect(d.deleted).toEqual(["T0001", "T0002"]);
  });
});

// ---------------------------------------------------------------------------
// Invention (forgery)
// ---------------------------------------------------------------------------

describe("diffTokens — invention", () => {
  it("caller introduces token IDs not in sidecar → invented", () => {
    const canonical = `${tok("T0001")}`;
    const caller = `${tok("T0001")} ${tok("T9999")}`;
    const d = diffTokens(canonical, caller, sidecarFor("T0001"));
    expect(d.preserved).toEqual(["T0001"]);
    expect(d.invented).toEqual(["T9999"]);
  });

  it("multiple invented tokens are de-duplicated in first-seen order", () => {
    const caller = `${tok("T9999")} ${tok("T8888")} ${tok("T9999")}`;
    const d = diffTokens("", caller, {});
    expect(d.invented).toEqual(["T9999", "T8888"]);
  });

  it("token present in sidecar but not in canonical is NOT invented (sidecar is the authority)", () => {
    // Contract: invented = caller IDs not in sidecar. If the sidecar
    // contains an entry not referenced by canonical, it just means that
    // entry is unused — the caller referencing it is still legitimate.
    const canonical = "";
    const caller = `${tok("T0042")}`;
    const d = diffTokens(canonical, caller, sidecarFor("T0042"));
    expect(d.invented).toEqual([]);
    // It also isn't deleted (canonical didn't have it) and isn't
    // preserved (canonical didn't have it) — effectively a no-op.
    expect(d.deleted).toEqual([]);
    expect(d.preserved).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reordering
// ---------------------------------------------------------------------------

describe("diffTokens — reordering", () => {
  it("same set, different order → reordered contains moved tokens", () => {
    const canonical = `${tok("T0001")} ${tok("T0002")} ${tok("T0003")}`;
    const caller = `${tok("T0003")} ${tok("T0002")} ${tok("T0001")}`;
    const d = diffTokens(canonical, caller, sidecarFor("T0001", "T0002", "T0003"));
    expect(d.preserved).toEqual(["T0001", "T0002", "T0003"]);
    expect(d.deleted).toEqual([]);
    expect(d.invented).toEqual([]);
    // T0001 and T0003 moved; T0002 stayed in the middle.
    expect(d.reordered).toEqual(["T0001", "T0003"]);
  });

  it("identical order (no move) → reordered empty", () => {
    const canonical = `${tok("T0001")} ${tok("T0002")}`;
    const caller = canonical;
    const d = diffTokens(canonical, caller, sidecarFor("T0001", "T0002"));
    expect(d.reordered).toEqual([]);
  });

  it("duplicate caller references don't spuriously mark reordering", () => {
    const canonical = `${tok("T0001")} ${tok("T0002")}`;
    const caller = `${tok("T0001")} ${tok("T0001")} ${tok("T0002")}`;
    const d = diffTokens(canonical, caller, sidecarFor("T0001", "T0002"));
    expect(d.reordered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mixed
// ---------------------------------------------------------------------------

describe("diffTokens — mixed buckets", () => {
  it("preserved + deleted + invented in one call", () => {
    // T0001 preserved, T0002 deleted, T9999 invented.
    const canonical = `${tok("T0001")} ${tok("T0002")}`;
    const caller = `${tok("T0001")} ${tok("T9999")}`;
    const d = diffTokens(canonical, caller, sidecarFor("T0001", "T0002"));
    expect(d.preserved).toEqual(["T0001"]);
    expect(d.deleted).toEqual(["T0002"]);
    expect(d.invented).toEqual(["T9999"]);
    expect(d.reordered).toEqual([]);
  });

  it("preserved + deleted + reordered + invented in one call", () => {
    // T0001 moved, T0002 preserved (same spot), T0003 deleted,
    // T9999 invented.
    const canonical = `${tok("T0001")} ${tok("T0002")} ${tok("T0003")}`;
    const caller = `${tok("T0002")} ${tok("T0001")} ${tok("T9999")}`;
    const d = diffTokens(canonical, caller, sidecarFor("T0001", "T0002", "T0003"));
    expect(d.preserved).toEqual(["T0001", "T0002"]);
    expect(d.deleted).toEqual(["T0003"]);
    expect(d.invented).toEqual(["T9999"]);
    // After restricting to preserved: canonical = [T0001, T0002],
    // caller = [T0002, T0001]. Both indices differ → both reordered.
    expect(d.reordered.sort()).toEqual(["T0001", "T0002"]);
  });
});
