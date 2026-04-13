import { describe, it, expect, vi, beforeEach } from "vitest";

// We need fresh module imports per test to avoid _config caching.
// Use dynamic imports with vi.resetModules().

const mockReadFromKeychain = vi.fn();
const mockGetProfileSettings = vi.fn();

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: (...args: unknown[]) => mockReadFromKeychain(...args),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

vi.mock("../shared/profiles.js", () => ({
  getProfileSettings: (...args: unknown[]) => mockGetProfileSettings(...args),
}));

// Capture process.exit calls — throw to halt execution like the real exit would
class ProcessExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

const mockExit = vi
  .spyOn(process, "exit")
  .mockImplementation((code?: number) => {
    throw new ProcessExitError(code ?? 0);
  });

beforeEach(() => {
  vi.clearAllMocks();
  // Clean all credential env vars before each test
  delete process.env.CONFLUENCE_PROFILE;
  delete process.env.CONFLUENCE_URL;
  delete process.env.CONFLUENCE_EMAIL;
  delete process.env.CONFLUENCE_API_TOKEN;
  delete process.env.CONFLUENCE_READ_ONLY;
  mockReadFromKeychain.mockResolvedValue(null);
  mockGetProfileSettings.mockResolvedValue(undefined);
});

async function importResolveCredentials() {
  // Reset modules to clear the _config singleton
  vi.resetModules();
  const mod = await import("./confluence-client.js");
  return mod.resolveCredentials;
}

describe("resolveCredentials", () => {
  describe("Step 1: CONFLUENCE_PROFILE", () => {
    it("resolves credentials from named keychain profile", async () => {
      process.env.CONFLUENCE_PROFILE = "globex";
      mockReadFromKeychain.mockResolvedValue({
        url: "https://globex.atlassian.net",
        email: "richard@globex.com",
        apiToken: "token-j",
      });

      const resolve = await importResolveCredentials();
      const result = await resolve();

      expect(result).toEqual({
        url: "https://globex.atlassian.net",
        email: "richard@globex.com",
        apiToken: "token-j",
        profile: "globex",
      });
      expect(mockReadFromKeychain).toHaveBeenCalledWith("globex");
    });

    it("strips trailing slash from keychain URL", async () => {
      process.env.CONFLUENCE_PROFILE = "test";
      mockReadFromKeychain.mockResolvedValue({
        url: "https://test.atlassian.net/",
        email: "a@b.com",
        apiToken: "tok",
      });

      const resolve = await importResolveCredentials();
      const result = await resolve();
      expect(result.url).toBe("https://test.atlassian.net");
    });

    it("exits when keychain entry not found for profile", async () => {
      process.env.CONFLUENCE_PROFILE = "missing";
      mockReadFromKeychain.mockResolvedValue(null);

      const resolve = await importResolveCredentials();
      await expect(resolve()).rejects.toThrow("process.exit(1)");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("exits on invalid profile name", async () => {
      process.env.CONFLUENCE_PROFILE = "-bad-name";

      const resolve = await importResolveCredentials();
      await expect(resolve()).rejects.toThrow("process.exit(1)");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("Step 2: All three env vars", () => {
    it("uses all three env vars directly", async () => {
      process.env.CONFLUENCE_URL = "https://ci.atlassian.net";
      process.env.CONFLUENCE_EMAIL = "ci@test.com";
      process.env.CONFLUENCE_API_TOKEN = "ci-token";

      const resolve = await importResolveCredentials();
      const result = await resolve();

      expect(result).toEqual({
        url: "https://ci.atlassian.net",
        email: "ci@test.com",
        apiToken: "ci-token",
        profile: null,
      });
      // Should not touch keychain
      expect(mockReadFromKeychain).not.toHaveBeenCalled();
    });

    it("clears CONFLUENCE_API_TOKEN from process.env after reading", async () => {
      process.env.CONFLUENCE_URL = "https://ci.atlassian.net";
      process.env.CONFLUENCE_EMAIL = "ci@test.com";
      process.env.CONFLUENCE_API_TOKEN = "ci-token";

      const resolve = await importResolveCredentials();
      await resolve();

      expect(process.env.CONFLUENCE_API_TOKEN).toBeUndefined();
    });

    it("strips trailing slash from URL env var", async () => {
      process.env.CONFLUENCE_URL = "https://ci.atlassian.net/";
      process.env.CONFLUENCE_EMAIL = "ci@test.com";
      process.env.CONFLUENCE_API_TOKEN = "ci-token";

      const resolve = await importResolveCredentials();
      const result = await resolve();
      expect(result.url).toBe("https://ci.atlassian.net");
    });
  });

  describe("Step 3: Partial env vars (hard error)", () => {
    it("exits when only CONFLUENCE_URL is set", async () => {
      process.env.CONFLUENCE_URL = "https://x.atlassian.net";

      const resolve = await importResolveCredentials();
      await expect(resolve()).rejects.toThrow("process.exit(1)");

      expect(mockExit).toHaveBeenCalledWith(1);
      // Must NOT fall back to keychain merging
      expect(mockReadFromKeychain).not.toHaveBeenCalled();
    });

    it("exits when only CONFLUENCE_EMAIL is set", async () => {
      process.env.CONFLUENCE_EMAIL = "a@b.com";

      const resolve = await importResolveCredentials();
      await expect(resolve()).rejects.toThrow("process.exit(1)");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockReadFromKeychain).not.toHaveBeenCalled();
    });

    it("exits when CONFLUENCE_URL and CONFLUENCE_EMAIL are set but not token", async () => {
      process.env.CONFLUENCE_URL = "https://x.atlassian.net";
      process.env.CONFLUENCE_EMAIL = "a@b.com";

      const resolve = await importResolveCredentials();
      await expect(resolve()).rejects.toThrow("process.exit(1)");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockReadFromKeychain).not.toHaveBeenCalled();
    });

    it("exits when only CONFLUENCE_API_TOKEN is set", async () => {
      process.env.CONFLUENCE_API_TOKEN = "some-token";

      const resolve = await importResolveCredentials();
      await expect(resolve()).rejects.toThrow("process.exit(1)");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("Step 3: No credentials at all", () => {
    it("exits when no env vars are set", async () => {
      const resolve = await importResolveCredentials();
      await expect(resolve()).rejects.toThrow("process.exit(1)");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});

async function importGetConfig() {
  vi.resetModules();
  const mod = await import("./confluence-client.js");
  return mod.getConfig;
}

describe("getConfig readOnly resolution", () => {
  it("sets readOnly: true when registry says read-only", async () => {
    process.env.CONFLUENCE_PROFILE = "acme";
    mockReadFromKeychain.mockResolvedValue({
      url: "https://acme.atlassian.net",
      email: "u@acme.com",
      apiToken: "tok",
    });
    mockGetProfileSettings.mockResolvedValue({ readOnly: true });

    const getConfig = await importGetConfig();
    const config = await getConfig();

    expect(config.readOnly).toBe(true);
    expect(mockGetProfileSettings).toHaveBeenCalledWith("acme");
  });

  it("sets readOnly: true when CONFLUENCE_READ_ONLY=true env var", async () => {
    process.env.CONFLUENCE_URL = "https://ci.atlassian.net";
    process.env.CONFLUENCE_EMAIL = "ci@test.com";
    process.env.CONFLUENCE_API_TOKEN = "ci-token";
    process.env.CONFLUENCE_READ_ONLY = "true";

    const getConfig = await importGetConfig();
    const config = await getConfig();

    expect(config.readOnly).toBe(true);
  });

  it("strict-mode invariant: CONFLUENCE_READ_ONLY=false does NOT override registry readOnly", async () => {
    process.env.CONFLUENCE_PROFILE = "acme";
    process.env.CONFLUENCE_READ_ONLY = "false";
    mockReadFromKeychain.mockResolvedValue({
      url: "https://acme.atlassian.net",
      email: "u@acme.com",
      apiToken: "tok",
    });
    mockGetProfileSettings.mockResolvedValue({ readOnly: true });

    const getConfig = await importGetConfig();
    const config = await getConfig();

    expect(config.readOnly).toBe(true);
  });

  it("sets readOnly: false when neither source says read-only", async () => {
    process.env.CONFLUENCE_URL = "https://ci.atlassian.net";
    process.env.CONFLUENCE_EMAIL = "ci@test.com";
    process.env.CONFLUENCE_API_TOKEN = "ci-token";

    const getConfig = await importGetConfig();
    const config = await getConfig();

    expect(config.readOnly).toBe(false);
  });

  it("readOnly is included in the frozen config object", async () => {
    process.env.CONFLUENCE_URL = "https://ci.atlassian.net";
    process.env.CONFLUENCE_EMAIL = "ci@test.com";
    process.env.CONFLUENCE_API_TOKEN = "ci-token";

    const getConfig = await importGetConfig();
    const config = await getConfig();

    expect(Object.isFrozen(config)).toBe(true);
    expect("readOnly" in config).toBe(true);
  });
});
