import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockStartServer = vi.fn().mockResolvedValue(undefined);
const mockRunSetup = vi.fn().mockResolvedValue(undefined);
const mockRunProfiles = vi.fn().mockResolvedValue(undefined);
const mockRunStatus = vi.fn().mockResolvedValue(undefined);
const mockRunAgentGuide = vi.fn();

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

vi.mock("./agent-guide.js", () => ({
  runAgentGuide: mockRunAgentGuide,
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
    process.argv = ["node", "index.js", "setup", "--profile", "globex"];
    vi.resetModules();
    vi.doMock("../server/index.js", () => ({ main: mockStartServer }));
    vi.doMock("./setup.js", () => ({ runSetup: mockRunSetup }));
    vi.doMock("./profiles.js", () => ({ runProfiles: mockRunProfiles }));
    vi.doMock("./status.js", () => ({ runStatus: mockRunStatus }));

    await import("./index.js");

    await new Promise((r) => setTimeout(r, 10));
    expect(mockRunSetup).toHaveBeenCalledWith("globex", undefined);
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

  it("calls runAgentGuide when 'agent-guide' argument is provided", async () => {
    process.argv = ["node", "index.js", "agent-guide"];
    vi.resetModules();
    vi.doMock("../server/index.js", () => ({ main: mockStartServer }));
    vi.doMock("./setup.js", () => ({ runSetup: mockRunSetup }));
    vi.doMock("./profiles.js", () => ({ runProfiles: mockRunProfiles }));
    vi.doMock("./status.js", () => ({ runStatus: mockRunStatus }));
    vi.doMock("./agent-guide.js", () => ({ runAgentGuide: mockRunAgentGuide }));

    await import("./index.js");

    await new Promise((r) => setTimeout(r, 10));
    expect(mockRunAgentGuide).toHaveBeenCalledOnce();
    expect(mockStartServer).not.toHaveBeenCalled();
  });

  it("calls runUpgrade when 'upgrade' argument is provided (Track A2)", async () => {
    const mockRunUpgrade = vi
      .fn()
      .mockResolvedValue({ status: "up-to-date", message: "Already on v1" });
    process.argv = ["node", "index.js", "upgrade"];
    vi.resetModules();
    vi.doMock("../server/index.js", () => ({ main: mockStartServer }));
    vi.doMock("./setup.js", () => ({ runSetup: mockRunSetup }));
    vi.doMock("./profiles.js", () => ({ runProfiles: mockRunProfiles }));
    vi.doMock("./status.js", () => ({ runStatus: mockRunStatus }));
    vi.doMock("./upgrade.js", () => ({ runUpgrade: mockRunUpgrade }));

    await import("./index.js");

    await new Promise((r) => setTimeout(r, 10));
    expect(mockRunUpgrade).toHaveBeenCalledOnce();
    expect(mockStartServer).not.toHaveBeenCalled();
  });

  describe("--profile for the server (setup's client snippets pass it)", () => {
    const origEnv = process.env.CONFLUENCE_PROFILE;
    let profileSeenByServer: string | undefined;
    let errors: string[];

    beforeEach(() => {
      profileSeenByServer = "(not started)";
      errors = [];
      mockStartServer.mockImplementation(async () => {
        profileSeenByServer = process.env.CONFLUENCE_PROFILE;
      });
      vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      delete process.env.CONFLUENCE_PROFILE;
    });

    afterEach(() => {
      vi.restoreAllMocks();
      mockStartServer.mockReset().mockResolvedValue(undefined);
      if (origEnv === undefined) delete process.env.CONFLUENCE_PROFILE;
      else process.env.CONFLUENCE_PROFILE = origEnv;
    });

    async function run(argv: string[]): Promise<void> {
      process.argv = ["node", "index.js", ...argv];
      vi.resetModules();
      vi.doMock("../server/index.js", () => ({ main: mockStartServer }));
      vi.doMock("./status.js", () => ({ runStatus: mockRunStatus }));
      await import("./index.js");
      await new Promise((r) => setTimeout(r, 10));
    }

    it("starts the server with the profile named by --profile", async () => {
      await run(["--profile", "acme"]);
      expect(mockStartServer).toHaveBeenCalledOnce();
      expect(profileSeenByServer).toBe("acme");
    });

    it("starts when --profile and CONFLUENCE_PROFILE agree", async () => {
      process.env.CONFLUENCE_PROFILE = "acme";
      await run(["--profile", "acme"]);
      expect(profileSeenByServer).toBe("acme");
    });

    it("refuses to start when --profile and CONFLUENCE_PROFILE differ, naming both", async () => {
      process.env.CONFLUENCE_PROFILE = "acme";
      await run(["--profile", "globex"]);
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(mockStartServer).not.toHaveBeenCalled();
      expect(errors.join("\n")).toMatch(/"globex".*CONFLUENCE_PROFILE="acme"/);
      expect(process.env.CONFLUENCE_PROFILE).toBe("acme"); // not overwritten
    });

    it.each([[["--profile"]], [["--profile", "--debug"]], [["--profile", "bad name"]]])(
      "refuses %j before starting",
      async (argv) => {
        await run(argv);
        expect(process.exit).toHaveBeenCalledWith(1);
        expect(mockStartServer).not.toHaveBeenCalled();
      },
    );

    it("without --profile the environment is left as it was", async () => {
      process.env.CONFLUENCE_PROFILE = "globex";
      await run([]);
      expect(profileSeenByServer).toBe("globex");
    });

    it("passes the arguments after 'status' to runStatus", async () => {
      await run(["status", "--profile", "acme"]);
      expect(mockRunStatus).toHaveBeenCalledWith(["--profile", "acme"]);
      expect(mockStartServer).not.toHaveBeenCalled();
    });
  });

  describe("errors the person can act on (0-D4)", () => {
    let errors: string[];

    beforeEach(() => {
      errors = [];
      vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** `make` builds the error from the fresh module graph (instanceof must match it). */
    async function runRejecting(make: (p: typeof import("../shared/profiles.js")) => unknown): Promise<void> {
      process.argv = ["node", "index.js", "profiles"];
      vi.resetModules();
      const err = make(await import("../shared/profiles.js"));
      vi.doMock("./profiles.js", () => ({ runProfiles: vi.fn().mockRejectedValue(err) }));
      await import("./index.js");
      await new Promise((r) => setTimeout(r, 10));
    }

    it("prints RegistryUnreadableError as what + fix, without a stack, and exits 1", async () => {
      await runRejecting(
        (p) => new p.RegistryUnreadableError({ kind: "unsafe-permissions", target: "file", problem: "mode" }, "/x/profiles.json"),
      );
      expect(process.exit).toHaveBeenCalledWith(1);
      const out = errors.join("\n");
      expect(out).toContain("Fix: chmod 600 /x/profiles.json");
      expect(out).toContain("nothing was changed");
      expect(out).not.toContain("Fatal error");
      expect(out).not.toMatch(/\n\s+at /);
    });

    it("prints a refused write (lock held) as its message and exits 1", async () => {
      await runRejecting((p) => new p.RegistryWriteRefusedError(p.REGISTRY_BUSY, "Another epimethian-mcp command is busy."));
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errors).toEqual(["Error: Another epimethian-mcp command is busy."]);
    });

    it("still prints other errors as a fatal error", async () => {
      await runRejecting(() => new Error("something else"));
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errors.join("\n")).toContain("Fatal error");
    });
  });
});
