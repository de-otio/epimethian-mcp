import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ELICITATION_UNSUPPORTED,
  GatedOperationError,
  USER_DENIED_GATED_OPERATION,
  gateOperation,
} from "./elicitation.js";

// Stub clientSupportsElicitation to control the capability-detection branch
// without constructing a full McpServer.
vi.mock("./index.js", () => ({
  clientSupportsElicitation: vi.fn(() => false),
}));

const { clientSupportsElicitation } = await import("./index.js");

function makeFakeServer(elicitInput: (...args: unknown[]) => unknown): any {
  return {
    server: { elicitInput },
  };
}

describe("gateOperation (E4)", () => {
  afterEach(() => {
    delete process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES;
    vi.mocked(clientSupportsElicitation).mockReturnValue(false);
  });

  it("E4: proceeds when user accepts with confirm=true", async () => {
    vi.mocked(clientSupportsElicitation).mockReturnValue(true);
    const elicit = vi.fn(async () => ({
      action: "accept",
      content: { confirm: true },
    }));
    const server = makeFakeServer(elicit);

    await expect(
      gateOperation(server, { tool: "delete_page", summary: "Delete?" }),
    ).resolves.toBeUndefined();
    expect(elicit).toHaveBeenCalledOnce();
  });

  it("E4: throws USER_DENIED on decline", async () => {
    vi.mocked(clientSupportsElicitation).mockReturnValue(true);
    const elicit = vi.fn(async () => ({ action: "decline", content: undefined }));
    const server = makeFakeServer(elicit);

    try {
      await gateOperation(server, { tool: "delete_page", summary: "Delete?" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GatedOperationError);
      expect((err as GatedOperationError).code).toBe(USER_DENIED_GATED_OPERATION);
      expect((err as Error).message).toContain("user declined");
    }
  });

  it("E4: throws USER_DENIED on cancel", async () => {
    vi.mocked(clientSupportsElicitation).mockReturnValue(true);
    const elicit = vi.fn(async () => ({ action: "cancel", content: undefined }));
    const server = makeFakeServer(elicit);

    try {
      await gateOperation(server, { tool: "revert_page", summary: "Revert?" });
      expect.unreachable();
    } catch (err) {
      expect((err as GatedOperationError).code).toBe(USER_DENIED_GATED_OPERATION);
      expect((err as Error).message).toContain("user cancelled");
    }
  });

  it("E4: throws USER_DENIED when user accepts but confirm=false", async () => {
    vi.mocked(clientSupportsElicitation).mockReturnValue(true);
    const elicit = vi.fn(async () => ({
      action: "accept",
      content: { confirm: false },
    }));
    const server = makeFakeServer(elicit);

    try {
      await gateOperation(server, { tool: "update_page", summary: "Update?" });
      expect.unreachable();
    } catch (err) {
      expect((err as GatedOperationError).code).toBe(USER_DENIED_GATED_OPERATION);
    }
  });

  it("E4: throws ELICITATION_UNSUPPORTED when client lacks capability and no opt-out", async () => {
    vi.mocked(clientSupportsElicitation).mockReturnValue(false);
    const server = makeFakeServer(() => {
      throw new Error("should not be called");
    });

    try {
      await gateOperation(server, { tool: "delete_page", summary: "Delete?" });
      expect.unreachable();
    } catch (err) {
      expect((err as GatedOperationError).code).toBe(ELICITATION_UNSUPPORTED);
    }
  });

  it("E4: opt-out flag lets unsupported-client path proceed silently", async () => {
    vi.mocked(clientSupportsElicitation).mockReturnValue(false);
    process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES = "true";
    const elicit = vi.fn();
    const server = makeFakeServer(elicit);

    await expect(
      gateOperation(server, { tool: "delete_page", summary: "Delete?" }),
    ).resolves.toBeUndefined();
    expect(elicit).not.toHaveBeenCalled();
  });

  it("E4: elicitation runtime error is treated as denial (fail-safe)", async () => {
    vi.mocked(clientSupportsElicitation).mockReturnValue(true);
    const elicit = vi.fn(async () => {
      throw new Error("transport blew up");
    });
    const server = makeFakeServer(elicit);

    try {
      await gateOperation(server, { tool: "delete_page", summary: "Delete?" });
      expect.unreachable();
    } catch (err) {
      expect((err as GatedOperationError).code).toBe(USER_DENIED_GATED_OPERATION);
      expect((err as Error).message).toContain("transport blew up");
    }
  });
});
