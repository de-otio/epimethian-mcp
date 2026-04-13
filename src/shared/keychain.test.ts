import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  accountForProfile,
  PROFILE_NAME_RE,
  saveToKeychain,
  readFromKeychain,
  deleteFromKeychain,
} from "./keychain.js";
import type { KeychainCredentials } from "./keychain.js";

// Mock child_process so we don't hit the real keychain
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile);

function mockExecSuccess(stdout = "") {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: null, stdout: string, stderr: string) => void)(
        null,
        stdout,
        ""
      );
      return {} as ReturnType<typeof execFile>;
    }
  );
}

function mockExecFailure(message = "not found") {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: Error, stdout: string, stderr: string) => void)(
        new Error(message),
        "",
        message
      );
      return {} as ReturnType<typeof execFile>;
    }
  );
}

const testCreds: KeychainCredentials = {
  url: "https://test.atlassian.net",
  email: "user@test.com",
  apiToken: "test-token-123",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default to darwin platform for tests
  vi.stubGlobal("process", { ...process, platform: "darwin" });
});

// --- Profile name validation ---

describe("PROFILE_NAME_RE", () => {
  const valid = [
    "a",
    "z",
    "0",
    "my-tenant",
    "client-123",
    "acme-corp",
    "a".repeat(63),
    "a-b-c-d",
    "123",
  ];

  const invalid = [
    "",
    "-starts-with-dash",
    "UPPERCASE",
    "MixedCase",
    "has spaces",
    "has/slash",
    "has\\backslash",
    "has.dots",
    "has_underscore",
    "a".repeat(64),
    "café",
    "null\x00byte",
    " leading-space",
    "trailing-space ",
  ];

  it.each(valid)("accepts valid name: %s", (name) => {
    expect(PROFILE_NAME_RE.test(name)).toBe(true);
  });

  it.each(invalid)("rejects invalid name: %s", (name) => {
    expect(PROFILE_NAME_RE.test(name)).toBe(false);
  });
});

describe("accountForProfile", () => {
  it("returns prefixed account name for valid profile", () => {
    expect(accountForProfile("globex")).toBe("confluence-credentials/globex");
  });

  it("returns prefixed account name for numeric profile", () => {
    expect(accountForProfile("123")).toBe("confluence-credentials/123");
  });

  it("returns prefixed account name for hyphenated profile", () => {
    expect(accountForProfile("acme-corp")).toBe(
      "confluence-credentials/acme-corp"
    );
  });

  it("accepts max-length name (63 chars)", () => {
    const name = "a".repeat(63);
    expect(accountForProfile(name)).toBe(`confluence-credentials/${name}`);
  });

  it("throws on empty string", () => {
    expect(() => accountForProfile("")).toThrow("Invalid profile name");
  });

  it("throws on name starting with dash", () => {
    expect(() => accountForProfile("-bad")).toThrow("Invalid profile name");
  });

  it("throws on uppercase", () => {
    expect(() => accountForProfile("BadName")).toThrow("Invalid profile name");
  });

  it("throws on name with slash", () => {
    expect(() => accountForProfile("a/b")).toThrow("Invalid profile name");
  });

  it("throws on name exceeding 63 chars", () => {
    expect(() => accountForProfile("a".repeat(64))).toThrow(
      "Invalid profile name"
    );
  });

  it("throws on name with spaces", () => {
    expect(() => accountForProfile("has spaces")).toThrow(
      "Invalid profile name"
    );
  });

  it("throws on unicode characters", () => {
    expect(() => accountForProfile("café")).toThrow("Invalid profile name");
  });
});

// --- saveToKeychain ---

describe("saveToKeychain", () => {
  it("uses legacy account when no profile is given", async () => {
    mockExecSuccess();
    await saveToKeychain(testCreds);
    // The add-generic-password call should use the legacy account name
    const addCall = mockExecFile.mock.calls.find(
      (call) => (call[1] as string[])[0] === "add-generic-password"
    );
    expect(addCall).toBeDefined();
    expect((addCall![1] as string[]).includes("confluence-credentials")).toBe(
      true
    );
    // Should NOT include a slash (profile separator)
    const accountArg =
      (addCall![1] as string[])[
        (addCall![1] as string[]).indexOf("-a") + 1
      ];
    expect(accountArg).toBe("confluence-credentials");
  });

  it("uses profiled account when profile is given", async () => {
    mockExecSuccess();
    await saveToKeychain(testCreds, "globex");
    const addCall = mockExecFile.mock.calls.find(
      (call) => (call[1] as string[])[0] === "add-generic-password"
    );
    expect(addCall).toBeDefined();
    const accountArg =
      (addCall![1] as string[])[
        (addCall![1] as string[]).indexOf("-a") + 1
      ];
    expect(accountArg).toBe("confluence-credentials/globex");
  });

  it("throws on invalid profile name", async () => {
    await expect(saveToKeychain(testCreds, "-bad")).rejects.toThrow(
      "Invalid profile name"
    );
  });
});

// --- readFromKeychain ---

describe("readFromKeychain", () => {
  it("returns credentials from legacy account when no profile given", async () => {
    mockExecSuccess(JSON.stringify(testCreds));
    const result = await readFromKeychain();
    expect(result).toEqual(testCreds);

    // Verify it used the legacy account
    const readCall = mockExecFile.mock.calls[0];
    const accountArg =
      (readCall![1] as string[])[
        (readCall![1] as string[]).indexOf("-a") + 1
      ];
    expect(accountArg).toBe("confluence-credentials");
  });

  it("returns credentials from profiled account when profile given", async () => {
    mockExecSuccess(JSON.stringify(testCreds));
    const result = await readFromKeychain("globex");
    expect(result).toEqual(testCreds);

    const readCall = mockExecFile.mock.calls[0];
    const accountArg =
      (readCall![1] as string[])[
        (readCall![1] as string[]).indexOf("-a") + 1
      ];
    expect(accountArg).toBe("confluence-credentials/globex");
  });

  it("returns null when entry not found", async () => {
    mockExecFailure("not found");
    const result = await readFromKeychain();
    expect(result).toBeNull();
  });

  it("returns null when entry not found for profile", async () => {
    mockExecFailure("not found");
    const result = await readFromKeychain("missing");
    expect(result).toBeNull();
  });

  it("throws on corrupted JSON in keychain", async () => {
    mockExecSuccess("not-valid-json{{{");
    await expect(readFromKeychain()).rejects.toThrow(
      "Corrupted keychain entry for legacy keychain entry: invalid JSON"
    );
  });

  it("throws on corrupted JSON with profile label", async () => {
    mockExecSuccess("not-valid-json{{{");
    await expect(readFromKeychain("globex")).rejects.toThrow(
      'Corrupted keychain entry for profile "globex": invalid JSON'
    );
  });

  it("throws when apiToken field is missing", async () => {
    mockExecSuccess(JSON.stringify({ url: "https://x.com", email: "a@b.com" }));
    await expect(readFromKeychain()).rejects.toThrow(
      "missing required fields"
    );
  });

  it("throws when url field is missing", async () => {
    mockExecSuccess(
      JSON.stringify({ email: "a@b.com", apiToken: "token" })
    );
    await expect(readFromKeychain()).rejects.toThrow(
      "missing required fields"
    );
  });

  it("throws when email field is missing", async () => {
    mockExecSuccess(
      JSON.stringify({ url: "https://x.com", apiToken: "token" })
    );
    await expect(readFromKeychain()).rejects.toThrow(
      "missing required fields"
    );
  });

  it("returns null on unsupported platform", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const result = await readFromKeychain();
    expect(result).toBeNull();
  });
});

// --- deleteFromKeychain ---

describe("deleteFromKeychain", () => {
  it("uses legacy account when no profile given", async () => {
    mockExecSuccess();
    await deleteFromKeychain();
    const deleteCall = mockExecFile.mock.calls[0];
    const accountArg =
      (deleteCall![1] as string[])[
        (deleteCall![1] as string[]).indexOf("-a") + 1
      ];
    expect(accountArg).toBe("confluence-credentials");
  });

  it("uses profiled account when profile given", async () => {
    mockExecSuccess();
    await deleteFromKeychain("globex");
    const deleteCall = mockExecFile.mock.calls[0];
    const accountArg =
      (deleteCall![1] as string[])[
        (deleteCall![1] as string[]).indexOf("-a") + 1
      ];
    expect(accountArg).toBe("confluence-credentials/globex");
  });

  it("does not throw when entry does not exist", async () => {
    mockExecFailure("not found");
    await expect(deleteFromKeychain()).resolves.toBeUndefined();
  });
});
