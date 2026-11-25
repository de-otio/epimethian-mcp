import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockTestConnection = vi.fn();
const mockFetchTenantInfo = vi.fn();
const mockSaveToKeychain = vi.fn().mockResolvedValue(undefined);
const mockReadFromKeychain = vi.fn().mockResolvedValue(null);

vi.mock("../shared/test-connection.js", () => ({
  testConnection: (...args: unknown[]) => mockTestConnection(...args),
  fetchTenantInfo: (...args: unknown[]) => mockFetchTenantInfo(...args),
}));

vi.mock("../shared/keychain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/keychain.js")>();
  return {
    // The pure record builder is the real one: setup's output is checked through it.
    buildKeychainRecord: actual.buildKeychainRecord,
    saveToKeychain: (...args: unknown[]) => {
      writes.push("keychain");
      return mockSaveToKeychain(...args);
    },
    readFromKeychain: (...args: unknown[]) => mockReadFromKeychain(...args),
    PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
  };
});

const mockAddToProfileRegistry = vi.fn().mockResolvedValue(undefined);
const mockSetProfileSettings = vi.fn().mockResolvedValue(undefined);
const mockAssertRegistryWritable = vi.fn().mockResolvedValue(undefined);
const mockRegisterProfile = vi.fn().mockResolvedValue(undefined);
// Order of the registry and keychain writes, as setup makes them.
const writes: string[] = [];

vi.mock("../shared/profiles.js", async (importOriginal) => ({
  // The real error classes and describeUnreadable (used by cli-errors.ts).
  ...(({ RegistryUnreadableError, RegistryWriteRefusedError, REGISTRY_BUSY, REGISTRY_CHANGING, describeUnreadable }) => ({
    RegistryUnreadableError,
    RegistryWriteRefusedError,
    REGISTRY_BUSY,
    REGISTRY_CHANGING,
    describeUnreadable,
  }))(await importOriginal<typeof import("../shared/profiles.js")>()),
  addToProfileRegistry: (...args: unknown[]) =>
    mockAddToProfileRegistry(...args),
  setProfileSettings: (...args: unknown[]) =>
    mockSetProfileSettings(...args),
  assertRegistryWritable: (...args: unknown[]) => mockAssertRegistryWritable(...args),
  registerProfile: (...args: unknown[]) => {
    writes.push("registry");
    return mockRegisterProfile(...args);
  },
}));

// Mock readline
const mockQuestion = vi.fn();
const mockClose = vi.fn();

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: mockQuestion,
    close: mockClose,
  }),
}));

import { runSetup } from "./setup.js";

describe("runSetup", () => {
  const originalIsTTY = process.stdin.isTTY;
  const originalSetRawMode = process.stdin.setRawMode;
  const originalExit = process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertRegistryWritable.mockReset().mockResolvedValue(undefined);
    mockRegisterProfile.mockReset().mockResolvedValue(undefined);
    mockSaveToKeychain.mockReset().mockResolvedValue(undefined);
    writes.length = 0;
    // mockClear / clearAllMocks does NOT drain the mockResolvedValueOnce queue
    // in vitest — stale "once" responses from earlier tests would otherwise be
    // consumed by the next test's first rl.question call. Explicitly reset.
    mockQuestion.mockReset();
    mockTestConnection.mockReset();
    mockFetchTenantInfo.mockReset();
    mockReadFromKeychain.mockReset();
    mockReadFromKeychain.mockResolvedValue(null);
    // Default: tenant_info unreachable (graceful degrade). Tests that exercise
    // the seal/confirmation path override this explicitly.
    mockFetchTenantInfo.mockResolvedValue({
      ok: false,
      message: "not tested",
    });
    exitCode = undefined;
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    process.stdin.setRawMode = vi.fn().mockReturnValue(process.stdin);
    process.exit = vi.fn((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as any;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, writable: true });
    process.stdin.setRawMode = originalSetRawMode;
    process.exit = originalExit;
  });

  it("exits with error when not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true });

    await expect(runSetup()).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });

  it("exits with error when URL is empty", async () => {
    mockQuestion.mockResolvedValueOnce(""); // url

    await expect(runSetup()).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });

  it("exits with error when URL does not start with https://", async () => {
    mockQuestion.mockResolvedValueOnce("http://example.com"); // url

    await expect(runSetup()).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });

  it("exits with error when email is empty", async () => {
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net") // url
      .mockResolvedValueOnce(""); // email

    await expect(runSetup()).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });

  it("exits with error when API token is empty", async () => {
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net")
      .mockResolvedValueOnce("user@test.com")
      .mockResolvedValueOnce("n"); // scoped token? no

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => cb("\n"), 0); // Enter with no input
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await expect(runSetup()).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);

    process.stdin.on = originalOn;
  });

  it("strips trailing slashes from URL", async () => {
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net///")
      .mockResolvedValueOnce("user@test.com")
      .mockResolvedValueOnce("n"); // scoped token? no

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("t"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await runSetup();

    expect(mockTestConnection).toHaveBeenCalledWith(
      "https://test.atlassian.net",
      "user@test.com",
      "t"
    );

    process.stdin.on = originalOn;
  });

  it("uses existing keychain credentials as defaults", async () => {
    mockReadFromKeychain.mockResolvedValueOnce({
      url: "https://existing.atlassian.net",
      email: "old@test.com",
      apiToken: "old-token",
    });

    // User presses Enter for both prompts (accepts defaults)
    mockQuestion
      .mockResolvedValueOnce("") // accept default URL
      .mockResolvedValueOnce("") // accept default email
      .mockResolvedValueOnce("n"); // scoped token? no

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("n"); cb("e"); cb("w"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await runSetup();

    expect(mockTestConnection).toHaveBeenCalledWith(
      "https://existing.atlassian.net",
      "old@test.com",
      "new"
    );
    expect(mockSaveToKeychain).toHaveBeenCalledWith(
      {
        url: "https://existing.atlassian.net",
        email: "old@test.com",
        apiToken: "new",
      },
      undefined
    );

    process.stdin.on = originalOn;
  });

  it("handles backspace in password input", async () => {
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net")
      .mockResolvedValueOnce("user@test.com")
      .mockResolvedValueOnce("n"); // scoped token? no

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => {
          cb("a");
          cb("b");
          cb("x");
          cb("\u007f"); // backspace - removes "x"
          cb("c");
          cb("\n");
        }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await runSetup();

    expect(mockTestConnection).toHaveBeenCalledWith(
      "https://test.atlassian.net",
      "user@test.com",
      "abc"
    );

    process.stdin.on = originalOn;
  });

  it("saves to keychain on successful connection", async () => {
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net") // url
      .mockResolvedValueOnce("user@test.com") // email
      .mockResolvedValueOnce("n"); // scoped token? no

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully. Found space \"Dev\".",
    });

    // Simulate password input: emit characters then Enter
    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => {
          cb("t");
          cb("o");
          cb("k");
          cb("\n");
        }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await runSetup();

    expect(mockTestConnection).toHaveBeenCalledWith(
      "https://test.atlassian.net",
      "user@test.com",
      "tok"
    );
    expect(mockSaveToKeychain).toHaveBeenCalledWith(
      {
        url: "https://test.atlassian.net",
        email: "user@test.com",
        apiToken: "tok",
      },
      undefined
    );

    process.stdin.on = originalOn;
  });

  it("exits on failed connection without saving", async () => {
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net")
      .mockResolvedValueOnce("user@test.com")
      .mockResolvedValueOnce("n"); // scoped token? no

    mockTestConnection.mockResolvedValueOnce({
      ok: false,
      message: "Token is invalid or expired",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => {
          cb("b");
          cb("a");
          cb("d");
          cb("\n");
        }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await expect(runSetup()).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
    expect(mockSaveToKeychain).not.toHaveBeenCalled();

    process.stdin.on = originalOn;
  });

  it("passes profile to saveToKeychain and addToProfileRegistry", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net")
      .mockResolvedValueOnce("user@test.com")
      .mockResolvedValueOnce("n") // scoped token? no
      .mockResolvedValueOnce("1"); // posture choice

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => {
          cb("t");
          cb("o");
          cb("k");
          cb("\n");
        }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await runSetup("globex");

    expect(mockSaveToKeychain).toHaveBeenCalledWith(
      {
        url: "https://test.atlassian.net",
        email: "user@test.com",
        apiToken: "tok",
      },
      "globex"
    );
    expect(mockRegisterProfile).toHaveBeenCalledWith("globex", { posture: "read-only" });

    process.stdin.on = originalOn;
  });

  describe("registry preflight (0-T6)", () => {
    async function unreadable() {
      const { RegistryUnreadableError } = await vi.importActual<typeof import("../shared/profiles.js")>(
        "../shared/profiles.js",
      );
      return new RegistryUnreadableError({ kind: "parse-error" }, "/x/profiles.json");
    }

    function typeTok(): () => void {
      const originalOn = process.stdin.on;
      process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
        if (event === "data") setTimeout(() => ["t", "o", "k", "\n"].forEach((c) => cb(c)), 0);
        return process.stdin;
      }) as any;
      process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
      process.stdin.pause = vi.fn().mockReturnValue(process.stdin);
      return () => {
        process.stdin.on = originalOn;
      };
    }

    it("an unreadable registry stops setup before any prompt or keychain access", async () => {
      const err = await unreadable();
      mockAssertRegistryWritable.mockRejectedValueOnce(err);
      await expect(runSetup("globex")).rejects.toBe(err);
      expect(mockQuestion).not.toHaveBeenCalled();
      expect(mockReadFromKeychain).not.toHaveBeenCalled();
      expect(mockSaveToKeychain).not.toHaveBeenCalled();
      expect(mockRegisterProfile).not.toHaveBeenCalled();
    });

    it("also without a profile name (setup checks the registry first in every mode)", async () => {
      mockAssertRegistryWritable.mockRejectedValueOnce(await unreadable());
      await expect(runSetup()).rejects.toMatchObject({ code: "REGISTRY_UNREADABLE" });
      expect(mockSaveToKeychain).not.toHaveBeenCalled();
    });

    /** url, email, "scoped? n", the token, then posture "1"; connection ok. */
    function siteAnswers(): () => void {
      mockQuestion
        .mockResolvedValueOnce("https://test.atlassian.net")
        .mockResolvedValueOnce("user@test.com")
        .mockResolvedValueOnce("n")
        .mockResolvedValueOnce("1");
      mockTestConnection.mockResolvedValueOnce({ ok: true, message: "Connected successfully." });
      vi.spyOn(console, "log").mockImplementation(() => {});
      return typeTok();
    }

    it("writes the registry (name and posture, one write) before the keychain, after every prompt", async () => {
      const restore = siteAnswers();
      try {
        await runSetup("globex");
      } finally {
        restore();
      }
      expect(writes).toEqual(["registry", "keychain"]);
      expect(mockRegisterProfile).toHaveBeenCalledTimes(1);
      expect(mockRegisterProfile).toHaveBeenCalledWith("globex", { posture: "read-only" });
      // The posture prompt (4th question) came before either write.
      expect(mockQuestion).toHaveBeenCalledTimes(4);
      expect(mockAddToProfileRegistry).not.toHaveBeenCalled();
      expect(mockSetProfileSettings).not.toHaveBeenCalled();
    });

    it("a registry write that fails (broken during the prompts, lock held) leaves the keychain untouched", async () => {
      const { RegistryWriteRefusedError, REGISTRY_BUSY } = await vi.importActual<
        typeof import("../shared/profiles.js")
      >("../shared/profiles.js");
      for (const err of [await unreadable(), new RegistryWriteRefusedError(REGISTRY_BUSY, "busy; nothing was changed")]) {
        mockRegisterProfile.mockRejectedValueOnce(err);
        const restore = siteAnswers();
        try {
          await expect(runSetup("globex")).rejects.toBe(err);
        } finally {
          restore();
        }
      }
      expect(mockSaveToKeychain).not.toHaveBeenCalled();
    });

    it("a keychain failure after the registry write says what changed, without the keychain tool's message", async () => {
      mockSaveToKeychain.mockRejectedValueOnce(new Error("security: add-generic-password -w SECRET-TOKEN-JSON failed"));
      const restore = siteAnswers();
      let err: unknown;
      try {
        err = await runSetup("globex").catch((e: unknown) => e);
      } finally {
        restore();
      }
      const { describeCliError, PartialChangeError } = await import("./cli-errors.js");
      expect(err).toBeInstanceOf(PartialChangeError);
      const text = describeCliError(err)!;
      expect(text).toContain('The profile registry now lists "globex" (posture: read-only)');
      expect(text).toContain("saving the credentials to the OS keychain failed");
      expect(text).toContain("run: epimethian-mcp setup --profile globex");
      expect(text).not.toContain("nothing was changed");
      expect(text).not.toContain("SECRET-TOKEN-JSON");
    });

    it("without a profile: no registry write, and a keychain failure names no token", async () => {
      mockQuestion
        .mockResolvedValueOnce("https://test.atlassian.net")
        .mockResolvedValueOnce("user@test.com")
        .mockResolvedValueOnce("n");
      mockTestConnection.mockResolvedValueOnce({ ok: true, message: "Connected successfully." });
      vi.spyOn(console, "log").mockImplementation(() => {});
      mockSaveToKeychain.mockRejectedValueOnce(new Error("-w SECRET-TOKEN-JSON"));
      const restore = typeTok();
      let err: unknown;
      try {
        err = await runSetup(undefined, "claude-code").catch((e: unknown) => e);
      } finally {
        restore();
      }
      expect(mockRegisterProfile).not.toHaveBeenCalled();
      expect(mockAssertRegistryWritable).toHaveBeenCalledTimes(1);
      const { describeCliError } = await import("./cli-errors.js");
      expect(describeCliError(err)).toMatch(/^Error: Saving the credentials to the OS keychain failed/);
      expect(describeCliError(err)).not.toContain("SECRET-TOKEN-JSON");
    });
  });

  it("exits on invalid profile name", async () => {
    await expect(runSetup("-bad")).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });

  // --- Track O4: Posture prompt tests ---

  it("defaults to read-only posture when user presses enter without input", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net") // url
      .mockResolvedValueOnce("user@test.com") // email
      .mockResolvedValueOnce("n") // scoped token? no
      .mockResolvedValueOnce(""); // posture prompt → default (empty input)

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("t"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    const logSpy = vi.spyOn(console, "log");
    await runSetup("acme");

    expect(mockRegisterProfile).toHaveBeenCalledWith("acme", { posture: "read-only" });
    // The printed list is what a read-only site profile registers: no write tool.
    const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    const listLine = out.split("\n").find((l) => l.startsWith("Available tools"))!;
    expect(listLine).toMatch(/^Available tools, read-only \(\d+\):/);
    const listed = out.split("Available tools, read-only")[1].split("\n")[1];
    expect(listed).toContain("get_page");
    expect(listed).toContain("search_pages");
    expect(listed).not.toContain("create_page");
    expect(listed).not.toContain("delete_page");
    logSpy.mockRestore();

    process.stdin.on = originalOn;
  });

  it("posture prompt appears with all three choices", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net") // url
      .mockResolvedValueOnce("user@test.com") // email
      .mockResolvedValueOnce("n") // scoped token? no
      .mockResolvedValueOnce("1"); // posture choice

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("t"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await runSetup("acme");

    // Find the posture question — should contain "[1]", "[2]", "[3]"
    const postureQuestionCalls = mockQuestion.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("MCP access mode")
    );
    expect(postureQuestionCalls.length).toBeGreaterThan(0);
    const postureQuestion = postureQuestionCalls[0][0];
    expect(postureQuestion).toContain("[1]");
    expect(postureQuestion).toContain("[2]");
    expect(postureQuestion).toContain("[3]");
    expect(postureQuestion).toContain("Read-only");
    expect(postureQuestion).toContain("Read-write");
    expect(postureQuestion).toContain("Detect at startup");

    process.stdin.on = originalOn;
  });

  it("choice 2 writes posture: read-write", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net") // url
      .mockResolvedValueOnce("user@test.com") // email
      .mockResolvedValueOnce("n") // scoped token? no
      .mockResolvedValueOnce("2"); // posture choice → read-write

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("t"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await runSetup("acme");

    expect(mockRegisterProfile).toHaveBeenCalledWith("acme", { posture: "read-write" });

    process.stdin.on = originalOn;
  });

  it("choice 3 writes posture: detect", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net") // url
      .mockResolvedValueOnce("user@test.com") // email
      .mockResolvedValueOnce("n") // scoped token? no
      .mockResolvedValueOnce("3"); // posture choice → detect

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("t"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    const logSpy = vi.spyOn(console, "log");
    await runSetup("acme");

    expect(mockRegisterProfile).toHaveBeenCalledWith("acme", { posture: "detect" });
    const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("Available tools depend on the startup probe (posture: detect).");
    expect(out).toMatch(/Only if the probe finds the token can write \(\d+ more\): .*create_page/);
    logSpy.mockRestore();

    process.stdin.on = originalOn;
  });

  it("invalid posture input re-prompts", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net") // url
      .mockResolvedValueOnce("user@test.com") // email
      .mockResolvedValueOnce("n") // scoped token? no
      .mockResolvedValueOnce("99") // invalid choice
      .mockResolvedValueOnce("2"); // retry with valid choice

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("t"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await runSetup("acme");

    // Verify setProfileSettings was called with the eventual valid choice
    expect(mockRegisterProfile).toHaveBeenCalledWith("acme", { posture: "read-write" });
    // Verify rl.question was called 5 times (url, email, scoped?, invalid, retry)
    expect(mockQuestion).toHaveBeenCalledTimes(5);

    process.stdin.on = originalOn;
  });

  it("non-numeric posture input re-prompts", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net") // url
      .mockResolvedValueOnce("user@test.com") // email
      .mockResolvedValueOnce("n") // scoped token? no
      .mockResolvedValueOnce("foo") // invalid input
      .mockResolvedValueOnce("1"); // retry with valid choice

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("t"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await runSetup("acme");

    expect(mockRegisterProfile).toHaveBeenCalledWith("acme", { posture: "read-only" });

    process.stdin.on = originalOn;
  });

  // --- Tenant seal (cloudId confirmation) ---

  it("seals profile with cloudId when tenant_info is reachable and user confirms", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockFetchTenantInfo.mockResolvedValueOnce({
      ok: true,
      info: { cloudId: "cid-abc-123", displayName: "Globex Corp" },
    });
    mockQuestion
      .mockResolvedValueOnce("https://globex.atlassian.net")
      .mockResolvedValueOnce("user@test.com")
      .mockResolvedValueOnce("n") // scoped token? no
      .mockResolvedValueOnce("y") // tenant confirmation
      .mockResolvedValueOnce("1"); // posture choice

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("t"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await runSetup("globex");

    expect(mockSaveToKeychain).toHaveBeenCalledWith(
      {
        url: "https://globex.atlassian.net",
        email: "user@test.com",
        apiToken: "t",
        cloudId: "cid-abc-123",
        tenantDisplayName: "Globex Corp",
      },
      "globex"
    );

    process.stdin.on = originalOn;
  });

  it("aborts without saving when user rejects the tenant confirmation", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockFetchTenantInfo.mockResolvedValueOnce({
      ok: true,
      info: { cloudId: "cid-xyz", displayName: "Wrong Tenant" },
    });
    mockQuestion
      .mockResolvedValueOnce("https://globex.atlassian.net")
      .mockResolvedValueOnce("user@test.com")
      .mockResolvedValueOnce("n") // scoped token? no
      .mockResolvedValueOnce("n"); // tenant confirmation → No

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("t"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await expect(runSetup("globex")).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
    expect(mockSaveToKeychain).not.toHaveBeenCalled();

    process.stdin.on = originalOn;
  });

  it("saves without a seal when tenant_info is unreachable (graceful degrade)", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockFetchTenantInfo.mockResolvedValueOnce({
      ok: false,
      message: "endpoint not found",
    });
    mockQuestion
      .mockResolvedValueOnce("https://onprem.example.com")
      .mockResolvedValueOnce("user@test.com")
      .mockResolvedValueOnce("n") // scoped token? no
      .mockResolvedValueOnce("1"); // posture choice

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("t"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await runSetup("onprem");

    expect(mockSaveToKeychain).toHaveBeenCalledWith(
      {
        url: "https://onprem.example.com",
        email: "user@test.com",
        apiToken: "t",
      },
      "onprem"
    );

    process.stdin.on = originalOn;
  });

  // --- --client flag tests ---

  it("exits with error when --client ID is unknown", async () => {
    await expect(runSetup(undefined, "nonexistent-client")).rejects.toThrow(
      "process.exit(1)"
    );
    expect(exitCode).toBe(1);
  });

  it("prints opencode config snippet after successful save with --client opencode", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockFetchTenantInfo.mockResolvedValueOnce({
      ok: false,
      message: "not tested",
    });
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net")
      .mockResolvedValueOnce("user@test.com")
      .mockResolvedValueOnce("n") // scoped token? no
      .mockResolvedValueOnce("1"); // posture choice

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("t"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await runSetup("globex", "opencode");

    const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    // Snippet should contain substituted profile and the opencode shape
    expect(allOutput).toContain("globex");
    expect(allOutput).toContain('"type": "local"');
    expect(allOutput).toContain("EPIMETHIAN_ALLOW_UNGATED_WRITES");
    // Warning should be printed
    expect(allOutput).toContain("OpenCode does not yet support MCP elicitation");

    consoleSpy.mockRestore();
    process.stdin.on = originalOn;
  });

  it("prints all client snippets when --client is absent", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockFetchTenantInfo.mockResolvedValueOnce({
      ok: false,
      message: "not tested",
    });
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net")
      .mockResolvedValueOnce("user@test.com")
      .mockResolvedValueOnce("n"); // scoped token? no

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("t"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    // No profile, no clientId → runs without profile-specific flow (no posture prompt)
    await runSetup(undefined, undefined);

    const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    // Should see headings for all seven clients
    expect(allOutput).toContain("Claude Code");
    expect(allOutput).toContain("Claude Desktop");
    expect(allOutput).toContain("Cursor");
    expect(allOutput).toContain("Windsurf");
    expect(allOutput).toContain("Zed");
    expect(allOutput).toContain("OpenCode");

    consoleSpy.mockRestore();
    process.stdin.on = originalOn;
  });

  it("prints only the specified client snippet when --client cursor is used", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockFetchTenantInfo.mockResolvedValueOnce({
      ok: false,
      message: "not tested",
    });
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net")
      .mockResolvedValueOnce("user@test.com")
      .mockResolvedValueOnce("n") // scoped token? no
      .mockResolvedValueOnce("1"); // posture choice

    mockTestConnection.mockResolvedValueOnce({
      ok: true,
      message: "Connected successfully.",
    });

    const originalOn = process.stdin.on;
    process.stdin.on = vi.fn((event: string, cb: (key: string) => void) => {
      if (event === "data") {
        setTimeout(() => { cb("t"); cb("\n"); }, 0);
      }
      return process.stdin;
    }) as any;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin);

    await runSetup("acme", "cursor");

    const allOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).toContain("Cursor");
    expect(allOutput).toContain("acme");
    // Should NOT show opencode-specific content
    expect(allOutput).not.toContain("EPIMETHIAN_ALLOW_UNGATED_WRITES");

    consoleSpy.mockRestore();
    process.stdin.on = originalOn;
  });
});
