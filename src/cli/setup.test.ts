import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockTestConnection = vi.fn();
const mockFetchTenantInfo = vi.fn();
const mockSaveToKeychain = vi.fn().mockResolvedValue(undefined);
const mockReadFromKeychain = vi.fn().mockResolvedValue(null);

vi.mock("../shared/test-connection.js", () => ({
  testConnection: (...args: unknown[]) => mockTestConnection(...args),
  fetchTenantInfo: (...args: unknown[]) => mockFetchTenantInfo(...args),
}));

vi.mock("../shared/keychain.js", () => ({
  saveToKeychain: (...args: unknown[]) => mockSaveToKeychain(...args),
  readFromKeychain: (...args: unknown[]) => mockReadFromKeychain(...args),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

const mockAddToProfileRegistry = vi.fn().mockResolvedValue(undefined);
const mockSetProfileSettings = vi.fn().mockResolvedValue(undefined);

vi.mock("../shared/profiles.js", () => ({
  addToProfileRegistry: (...args: unknown[]) =>
    mockAddToProfileRegistry(...args),
  setProfileSettings: (...args: unknown[]) =>
    mockSetProfileSettings(...args),
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
      .mockResolvedValueOnce("user@test.com");

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
      .mockResolvedValueOnce("user@test.com");

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
      .mockResolvedValueOnce(""); // accept default email

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
      .mockResolvedValueOnce("user@test.com");

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
      .mockResolvedValueOnce("user@test.com"); // email

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
      .mockResolvedValueOnce("user@test.com");

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
    expect(mockAddToProfileRegistry).toHaveBeenCalledWith("globex");

    process.stdin.on = originalOn;
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

    await runSetup("acme");

    expect(mockSetProfileSettings).toHaveBeenCalledWith("acme", { posture: "read-only" });

    process.stdin.on = originalOn;
  });

  it("posture prompt appears with all three choices", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net") // url
      .mockResolvedValueOnce("user@test.com") // email
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

    expect(mockSetProfileSettings).toHaveBeenCalledWith("acme", { posture: "read-write" });

    process.stdin.on = originalOn;
  });

  it("choice 3 writes posture: detect", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net") // url
      .mockResolvedValueOnce("user@test.com") // email
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

    await runSetup("acme");

    expect(mockSetProfileSettings).toHaveBeenCalledWith("acme", { posture: "detect" });

    process.stdin.on = originalOn;
  });

  it("invalid posture input re-prompts", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net") // url
      .mockResolvedValueOnce("user@test.com") // email
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
    expect(mockSetProfileSettings).toHaveBeenCalledWith("acme", { posture: "read-write" });
    // Verify rl.question was called 4 times (url, email, invalid, retry)
    expect(mockQuestion).toHaveBeenCalledTimes(4);

    process.stdin.on = originalOn;
  });

  it("non-numeric posture input re-prompts", async () => {
    mockReadFromKeychain.mockResolvedValueOnce(null);
    mockQuestion
      .mockResolvedValueOnce("https://test.atlassian.net") // url
      .mockResolvedValueOnce("user@test.com") // email
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

    expect(mockSetProfileSettings).toHaveBeenCalledWith("acme", { posture: "read-only" });

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
});
