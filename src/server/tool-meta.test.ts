import { describe, expect, it } from "vitest";
import {
  ALWAYS_LOAD_META_KEY,
  MAX_RESULT_SIZE_META_KEY,
  REQUIRES_USER_INTERACTION_META_KEY,
  destructiveTool,
  readOnlyTool,
  writeTool,
} from "./tool-meta.js";

describe("tool-meta", () => {
  it("readOnlyTool declares a read-only, non-destructive, idempotent, open-world tool", () => {
    const meta = readOnlyTool("Get page");
    expect(meta).toEqual({
      title: "Get page",
      annotations: {
        title: "Get page",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    });
    expect(meta._meta).toBeUndefined();
  });

  it("writeTool is not read-only and not destructive; idempotent defaults to false", () => {
    expect(writeTool("Create page").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(writeTool("Add label", { idempotent: true }).annotations.idempotentHint).toBe(true);
    expect(writeTool("Create page")._meta).toBeUndefined();
  });

  it("destructiveTool sets destructiveHint and only adds _meta when asked", () => {
    const plain = destructiveTool("Update page");
    expect(plain.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(plain._meta).toBeUndefined();

    const gated = destructiveTool("Delete page", { idempotent: true, requiresUserInteraction: true });
    expect(gated.annotations.idempotentHint).toBe(true);
    expect(gated._meta).toEqual({ [REQUIRES_USER_INTERACTION_META_KEY]: true });
  });

  it("uses the key Claude Code honours", () => {
    expect(REQUIRES_USER_INTERACTION_META_KEY).toBe("anthropic/requiresUserInteraction");
  });

  it("rejects an empty title", () => {
    expect(() => readOnlyTool("  ")).toThrow(/title must be non-empty/);
  });

  it("readOnlyTool adds alwaysLoad and maxResultSizeChars only when asked", () => {
    expect(readOnlyTool("Get page", { alwaysLoad: true })._meta).toEqual({ [ALWAYS_LOAD_META_KEY]: true });
    expect(readOnlyTool("Get page", { maxResultSizeChars: 200_000 })._meta).toEqual({
      [MAX_RESULT_SIZE_META_KEY]: 200_000,
    });
    expect(readOnlyTool("Get page", { alwaysLoad: false })._meta).toBeUndefined();
  });

  it("rejects a maxResultSizeChars Claude Code would ignore or that lowers the default", () => {
    // Claude Code's own threshold is 50,000 and its ceiling 500,000.
    expect(() => readOnlyTool("X", { maxResultSizeChars: 50_000 })).toThrow();
    expect(() => readOnlyTool("X", { maxResultSizeChars: 500_001 })).toThrow();
    expect(() => readOnlyTool("X", { maxResultSizeChars: 100_000.5 })).toThrow();
    expect(readOnlyTool("X", { maxResultSizeChars: 50_001 })._meta).toBeDefined();
    expect(readOnlyTool("X", { maxResultSizeChars: 500_000 })._meta).toBeDefined();
  });
});
