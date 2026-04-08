import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTestConnection = vi.fn();
const mockSaveToKeychain = vi.fn().mockResolvedValue(undefined);
const mockReadFromKeychain = vi.fn().mockResolvedValue(null);

vi.mock("../shared/test-connection.js", () => ({
  testConnection: (...args: unknown[]) => mockTestConnection(...args),
}));

vi.mock("../shared/keychain.js", () => ({
  saveToKeychain: (...args: unknown[]) => mockSaveToKeychain(...args),
  readFromKeychain: () => mockReadFromKeychain(),
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
    expect(mockSaveToKeychain).toHaveBeenCalledWith({
      url: "https://test.atlassian.net",
      email: "user@test.com",
      apiToken: "tok",
    });

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
});
