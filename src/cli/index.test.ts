import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStartServer = vi.fn().mockResolvedValue(undefined);
const mockRunSetup = vi.fn().mockResolvedValue(undefined);

vi.mock("../server/index.js", () => ({
  main: mockStartServer,
}));

vi.mock("./setup.js", () => ({
  runSetup: mockRunSetup,
}));

describe("CLI entry point", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls startServer when no arguments", async () => {
    process.argv = ["node", "index.js"];
    // Re-import to trigger the routing logic
    vi.resetModules();
    vi.doMock("../server/index.js", () => ({ main: mockStartServer }));
    vi.doMock("./setup.js", () => ({ runSetup: mockRunSetup }));

    await import("./index.js");

    // Give the async run() a tick to complete
    await new Promise((r) => setTimeout(r, 10));
    expect(mockStartServer).toHaveBeenCalledOnce();
    expect(mockRunSetup).not.toHaveBeenCalled();
  });

  it("calls runSetup when 'setup' argument is provided", async () => {
    process.argv = ["node", "index.js", "setup"];
    vi.resetModules();
    vi.doMock("../server/index.js", () => ({ main: mockStartServer }));
    vi.doMock("./setup.js", () => ({ runSetup: mockRunSetup }));

    await import("./index.js");

    await new Promise((r) => setTimeout(r, 10));
    expect(mockRunSetup).toHaveBeenCalledOnce();
    expect(mockStartServer).not.toHaveBeenCalled();
  });
});
