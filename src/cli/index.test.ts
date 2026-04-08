import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStartServer = vi.fn().mockResolvedValue(undefined);
const mockRunSetup = vi.fn().mockResolvedValue(undefined);
const mockRunProfiles = vi.fn().mockResolvedValue(undefined);
const mockRunStatus = vi.fn().mockResolvedValue(undefined);

vi.mock("../server/index.js", () => ({
  main: mockStartServer,
}));

vi.mock("./setup.js", () => ({
  runSetup: mockRunSetup,
}));

vi.mock("./profiles.js", () => ({
  runProfiles: mockRunProfiles,
}));

vi.mock("./status.js", () => ({
  runStatus: mockRunStatus,
}));

describe("CLI entry point", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls startServer when no arguments", async () => {
    process.argv = ["node", "index.js"];
    vi.resetModules();
    vi.doMock("../server/index.js", () => ({ main: mockStartServer }));
    vi.doMock("./setup.js", () => ({ runSetup: mockRunSetup }));
    vi.doMock("./profiles.js", () => ({ runProfiles: mockRunProfiles }));
    vi.doMock("./status.js", () => ({ runStatus: mockRunStatus }));

    await import("./index.js");

    await new Promise((r) => setTimeout(r, 10));
    expect(mockStartServer).toHaveBeenCalledOnce();
    expect(mockRunSetup).not.toHaveBeenCalled();
  });

  it("calls runSetup when 'setup' argument is provided", async () => {
    process.argv = ["node", "index.js", "setup"];
    vi.resetModules();
    vi.doMock("../server/index.js", () => ({ main: mockStartServer }));
    vi.doMock("./setup.js", () => ({ runSetup: mockRunSetup }));
    vi.doMock("./profiles.js", () => ({ runProfiles: mockRunProfiles }));
    vi.doMock("./status.js", () => ({ runStatus: mockRunStatus }));

    await import("./index.js");

    await new Promise((r) => setTimeout(r, 10));
    expect(mockRunSetup).toHaveBeenCalledOnce();
    expect(mockStartServer).not.toHaveBeenCalled();
  });

  it("passes --profile to runSetup", async () => {
    process.argv = ["node", "index.js", "setup", "--profile", "jambit"];
    vi.resetModules();
    vi.doMock("../server/index.js", () => ({ main: mockStartServer }));
    vi.doMock("./setup.js", () => ({ runSetup: mockRunSetup }));
    vi.doMock("./profiles.js", () => ({ runProfiles: mockRunProfiles }));
    vi.doMock("./status.js", () => ({ runStatus: mockRunStatus }));

    await import("./index.js");

    await new Promise((r) => setTimeout(r, 10));
    expect(mockRunSetup).toHaveBeenCalledWith("jambit");
  });

  it("calls runProfiles when 'profiles' argument is provided", async () => {
    process.argv = ["node", "index.js", "profiles"];
    vi.resetModules();
    vi.doMock("../server/index.js", () => ({ main: mockStartServer }));
    vi.doMock("./setup.js", () => ({ runSetup: mockRunSetup }));
    vi.doMock("./profiles.js", () => ({ runProfiles: mockRunProfiles }));
    vi.doMock("./status.js", () => ({ runStatus: mockRunStatus }));

    await import("./index.js");

    await new Promise((r) => setTimeout(r, 10));
    expect(mockRunProfiles).toHaveBeenCalledOnce();
    expect(mockStartServer).not.toHaveBeenCalled();
  });

  it("calls runStatus when 'status' argument is provided", async () => {
    process.argv = ["node", "index.js", "status"];
    vi.resetModules();
    vi.doMock("../server/index.js", () => ({ main: mockStartServer }));
    vi.doMock("./setup.js", () => ({ runSetup: mockRunSetup }));
    vi.doMock("./profiles.js", () => ({ runProfiles: mockRunProfiles }));
    vi.doMock("./status.js", () => ({ runStatus: mockRunStatus }));

    await import("./index.js");

    await new Promise((r) => setTimeout(r, 10));
    expect(mockRunStatus).toHaveBeenCalledOnce();
    expect(mockStartServer).not.toHaveBeenCalled();
  });
});
