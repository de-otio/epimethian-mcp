import { describe, expect, it } from "vitest";
import {
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
});
