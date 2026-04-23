import { afterEach, describe, expect, it } from "vitest";
import {
  DESTRUCTIVE_FLAG_FROM_TOOL_OUTPUT,
  SOURCE_REQUIRED,
  listDestructiveFlagsSet,
  validateSource,
} from "./source-provenance.js";

describe("validateSource (E2)", () => {
  afterEach(() => {
    delete process.env.EPIMETHIAN_REQUIRE_SOURCE;
  });

  it("E2: omitted source + no destructive flags → inferred_user_request", () => {
    expect(validateSource(undefined, [])).toBe("inferred_user_request");
  });

  it("E2: omitted source + destructive flags → inferred_user_request (permissive default)", () => {
    expect(validateSource(undefined, ["confirm_shrinkage"])).toBe(
      "inferred_user_request",
    );
  });

  it("E2: omitted source + destructive flags + EPIMETHIAN_REQUIRE_SOURCE=true → throws SOURCE_REQUIRED", () => {
    process.env.EPIMETHIAN_REQUIRE_SOURCE = "true";
    expect(() => validateSource(undefined, ["replace_body"])).toThrow(
      /EPIMETHIAN_REQUIRE_SOURCE/,
    );
    try {
      validateSource(undefined, ["replace_body"]);
    } catch (err) {
      expect((err as { code?: string }).code).toBe(SOURCE_REQUIRED);
    }
  });

  it("E2: explicit user_request + destructive flags → user_request", () => {
    expect(validateSource("user_request", ["confirm_shrinkage"])).toBe(
      "user_request",
    );
  });

  it("E2: explicit file_or_cli_input is allowed with destructive flags", () => {
    expect(validateSource("file_or_cli_input", ["replace_body"])).toBe(
      "file_or_cli_input",
    );
  });

  it("E2: chained_tool_output + any destructive flag → throws DESTRUCTIVE_FLAG_FROM_TOOL_OUTPUT", () => {
    try {
      validateSource("chained_tool_output", ["confirm_shrinkage"]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { code?: string }).code).toBe(
        DESTRUCTIVE_FLAG_FROM_TOOL_OUTPUT,
      );
    }
  });

  it("E2: chained_tool_output rejection lists the specific destructive flags in the message", () => {
    try {
      validateSource("chained_tool_output", [
        "confirm_shrinkage",
        "replace_body",
      ]);
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("confirm_shrinkage");
      expect(msg).toContain("replace_body");
    }
  });

  it("E2: chained_tool_output WITHOUT destructive flags is allowed (legitimate use: agent summarising a read)", () => {
    expect(validateSource("chained_tool_output", [])).toBe("chained_tool_output");
  });
});

describe("listDestructiveFlagsSet (E2)", () => {
  it("returns empty array when no flags set", () => {
    expect(listDestructiveFlagsSet({})).toEqual([]);
  });

  it("maps each flag name to its snake_case key", () => {
    expect(
      listDestructiveFlagsSet({
        confirmShrinkage: true,
        confirmStructureLoss: true,
        replaceBody: true,
      }),
    ).toEqual(["confirm_shrinkage", "confirm_structure_loss", "replace_body"]);
  });

  it("treats confirm_deletions: true-string-array as set", () => {
    expect(
      listDestructiveFlagsSet({ confirmDeletions: ["T0001"] }),
    ).toEqual(["confirm_deletions"]);
  });

  it("treats confirm_deletions: true boolean as set", () => {
    expect(listDestructiveFlagsSet({ confirmDeletions: true })).toEqual([
      "confirm_deletions",
    ]);
  });

  it("treats confirm_deletions: false as not set", () => {
    expect(listDestructiveFlagsSet({ confirmDeletions: false })).toEqual([]);
  });

  it("treats defined targetVersion as set", () => {
    expect(listDestructiveFlagsSet({ targetVersion: 3 })).toEqual([
      "target_version",
    ]);
  });
});
