import { describe, it, expect, vi, beforeEach } from "vitest";

// validateStartup's seal behavior is the focus. We need fresh module imports
// per test to avoid the _config singleton in confluence-client.ts.

const mockReadFromKeychain = vi.fn();
const mockSaveToKeychain = vi.fn();
const mockGetProfileSettings = vi.fn();
const mockTestConnection = vi.fn();
const mockVerifyTenantIdentity = vi.fn();
const mockFetchTenantInfo = vi.fn();

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: (...args: unknown[]) => mockReadFromKeychain(...args),
  saveToKeychain: (...args: unknown[]) => mockSaveToKeychain(...args),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

vi.mock("../shared/profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/profiles.js")>();
  return {
    ...actual,
    getProfileSettings: (...args: unknown[]) => mockGetProfileSettings(...args),
  };
});

vi.mock("../shared/test-connection.js", () => ({
  testConnection: (...args: unknown[]) => mockTestConnection(...args),
  verifyTenantIdentity: (...args: unknown[]) => mockVerifyTenantIdentity(...args),
  fetchTenantInfo: (...args: unknown[]) => mockFetchTenantInfo(...args),
}));

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

// Silence stderr in tests — we assert on the mocks, not on the console stream.
vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  mockReadFromKeychain.mockReset();
  mockSaveToKeychain.mockReset();
  mockGetProfileSettings.mockReset();
  mockTestConnection.mockReset();
  mockVerifyTenantIdentity.mockReset();
  mockFetchTenantInfo.mockReset();
  mockExit.mockClear();
  delete process.env.CONFLUENCE_PROFILE;
  delete process.env.CONFLUENCE_URL;
  delete process.env.CONFLUENCE_EMAIL;
  delete process.env.CONFLUENCE_API_TOKEN;
  delete process.env.CONFLUENCE_READ_ONLY;
  mockGetProfileSettings.mockResolvedValue(undefined);
  mockTestConnection.mockResolvedValue({ ok: true, message: "Connected" });
  mockVerifyTenantIdentity.mockResolvedValue({
    ok: true,
    authenticatedEmail: "user@test.com",
    message: "Verified",
  });
});

async function loadModule() {
  vi.resetModules();
  return import("./confluence-client.js");
}

describe("validateStartup — tenant seal", () => {
  it("passes when the stored cloudId matches the live cloudId", async () => {
    process.env.CONFLUENCE_PROFILE = "acme";
    mockReadFromKeychain.mockResolvedValue({
      url: "https://acme.atlassian.net",
      email: "user@test.com",
      apiToken: "tok",
      cloudId: "cid-acme-001",
      tenantDisplayName: "Acme Corp",
    });
    mockFetchTenantInfo.mockResolvedValue({
      ok: true,
      info: { cloudId: "cid-acme-001", displayName: "Acme Corp" },
    });

    const { getConfig, validateStartup } = await loadModule();
    const config = await getConfig();
    await validateStartup(config);

    expect(mockFetchTenantInfo).toHaveBeenCalledTimes(1);
    expect(mockSaveToKeychain).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("hard-errors on cloudId mismatch (the core cross-tenant guard)", async () => {
    process.env.CONFLUENCE_PROFILE = "acme";
    mockReadFromKeychain.mockResolvedValue({
      url: "https://acme.atlassian.net",
      email: "user@test.com",
      apiToken: "tok",
      cloudId: "cid-acme-001",
      tenantDisplayName: "Acme Corp",
    });
    // Same URL/email authenticates, but the tenant behind it is different.
    mockFetchTenantInfo.mockResolvedValue({
      ok: true,
      info: { cloudId: "cid-globex-999", displayName: "Globex Corp" },
    });

    const { getConfig, validateStartup } = await loadModule();
    const config = await getConfig();

    await expect(validateStartup(config)).rejects.toThrow("process.exit(1)");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockSaveToKeychain).not.toHaveBeenCalled();
  });

  it("opportunistically seals a pre-5.5 profile that has no stored cloudId", async () => {
    process.env.CONFLUENCE_PROFILE = "legacy";
    mockReadFromKeychain.mockResolvedValue({
      url: "https://legacy.atlassian.net",
      email: "user@test.com",
      apiToken: "tok",
      // no cloudId / tenantDisplayName
    });
    mockFetchTenantInfo.mockResolvedValue({
      ok: true,
      info: { cloudId: "cid-legacy-42", displayName: "Legacy Co" },
    });
    mockSaveToKeychain.mockResolvedValue(undefined);

    const { getConfig, validateStartup } = await loadModule();
    const config = await getConfig();
    await validateStartup(config);

    expect(mockSaveToKeychain).toHaveBeenCalledTimes(1);
    const [credsArg, profileArg] = mockSaveToKeychain.mock.calls[0];
    expect(credsArg).toMatchObject({
      url: "https://legacy.atlassian.net",
      email: "user@test.com",
      apiToken: "tok",
      cloudId: "cid-legacy-42",
      tenantDisplayName: "Legacy Co",
    });
    expect(profileArg).toBe("legacy");
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("hard-fails when tenant_info is unreachable AND the profile is sealed (fail-closed)", async () => {
    // An attacker who can selectively block /_edge/tenant_info (network MITM,
    // DNS poisoning, egress filter) would bypass the seal entirely if we
    // degraded gracefully here. Fail closed to defeat that.
    process.env.CONFLUENCE_PROFILE = "acme";
    mockReadFromKeychain.mockResolvedValue({
      url: "https://acme.atlassian.net",
      email: "user@test.com",
      apiToken: "tok",
      cloudId: "cid-acme-001",
      tenantDisplayName: "Acme Corp",
    });
    mockFetchTenantInfo.mockResolvedValue({
      ok: false,
      message: "endpoint not found",
    });

    const { getConfig, validateStartup } = await loadModule();
    const config = await getConfig();

    await expect(validateStartup(config)).rejects.toThrow("process.exit(1)");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockSaveToKeychain).not.toHaveBeenCalled();
  });

  it("gracefully degrades when tenant_info is unreachable AND the profile is pre-5.5 (no seal yet)", async () => {
    // Profiles without a stored cloudId are unsealed — there's nothing to
    // verify against, so we cannot fail closed without blocking legitimate
    // upgrades from pre-5.5. Log a warning and continue; seal will be
    // attempted on the next startup.
    process.env.CONFLUENCE_PROFILE = "legacy";
    mockReadFromKeychain.mockResolvedValue({
      url: "https://legacy.atlassian.net",
      email: "user@test.com",
      apiToken: "tok",
      // no cloudId / tenantDisplayName
    });
    mockFetchTenantInfo.mockResolvedValue({
      ok: false,
      message: "endpoint not found",
    });

    const { getConfig, validateStartup } = await loadModule();
    const config = await getConfig();
    await validateStartup(config);

    expect(mockSaveToKeychain).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("skips seal verification entirely in env-var mode (no profile)", async () => {
    process.env.CONFLUENCE_URL = "https://ci.atlassian.net";
    process.env.CONFLUENCE_EMAIL = "ci@test.com";
    process.env.CONFLUENCE_API_TOKEN = "ci-token";

    const { getConfig, validateStartup } = await loadModule();
    const config = await getConfig();
    await validateStartup(config);

    expect(mockFetchTenantInfo).not.toHaveBeenCalled();
    expect(mockSaveToKeychain).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("continues without sealing if saveToKeychain fails during opportunistic seal", async () => {
    process.env.CONFLUENCE_PROFILE = "legacy";
    mockReadFromKeychain.mockResolvedValue({
      url: "https://legacy.atlassian.net",
      email: "user@test.com",
      apiToken: "tok",
    });
    mockFetchTenantInfo.mockResolvedValue({
      ok: true,
      info: { cloudId: "cid-legacy-42", displayName: "Legacy Co" },
    });
    mockSaveToKeychain.mockRejectedValue(new Error("keychain locked"));

    const { getConfig, validateStartup } = await loadModule();
    const config = await getConfig();
    await validateStartup(config);

    expect(mockSaveToKeychain).toHaveBeenCalledTimes(1);
    expect(mockExit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 0-T8: an unreadable registry stops getConfig, so the posture-"detect" write
// probe (a dry-run PUT) is never sent. 7.6.0 treated the file as empty and
// went on to probe.
// ---------------------------------------------------------------------------

describe("getConfig with an unreadable registry (0-T8)", () => {
  const creds = { url: "https://example.atlassian.net", email: "user@example.com", apiToken: "tok" };

  it("throws RegistryUnreadableError from the passed startup read; no request is made", async () => {
    process.env.CONFLUENCE_PROFILE = "work";
    mockReadFromKeychain.mockResolvedValue(creds);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { getConfig } = await loadModule();
      const { RegistryUnreadableError } = await import("../shared/profiles.js");
      const registry = {
        state: "unreadable" as const,
        reason: { kind: "parse-error" as const, line: 2, column: 5 },
        path: "/home/u/.config/epimethian-mcp/profiles.json",
        backup: undefined,
        observed: "absent" as const,
      };
      const err = await getConfig({ registry }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RegistryUnreadableError);
      expect(err).toMatchObject({ reason: { kind: "parse-error", line: 2, column: 5 } });
      // Not read again from disk: the passed read is the only source.
      expect(mockGetProfileSettings).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockTestConnection).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws when it reads the registry itself (no posture fallback)", async () => {
    process.env.CONFLUENCE_PROFILE = "work";
    mockReadFromKeychain.mockResolvedValue(creds);
    const { RegistryUnreadableError } = await import("../shared/profiles.js");
    mockGetProfileSettings.mockRejectedValue(
      new RegistryUnreadableError({ kind: "unexpected-shape" }, "/x/profiles.json"),
    );
    const { getConfig } = await loadModule();
    await expect(getConfig()).rejects.toMatchObject({ code: "REGISTRY_UNREADABLE" });
  });

  it("uses the passed ok read for posture and does not read the file again", async () => {
    process.env.CONFLUENCE_PROFILE = "work";
    mockReadFromKeychain.mockResolvedValue(creds);
    const { getConfig } = await loadModule();
    const config = await getConfig({
      registry: {
        state: "ok",
        registry: { profiles: ["work"], settings: { work: { posture: "read-only" } }, extra: {} },
        observed: { ino: 1n, mtimeNs: 1n, ctimeNs: 1n, size: 1n },
      },
    });
    expect(config.posture).toBe("read-only");
    expect(mockGetProfileSettings).not.toHaveBeenCalled();
  });

  it("env-var mode ignores the registry entirely", async () => {
    process.env.CONFLUENCE_URL = "https://example.atlassian.net";
    process.env.CONFLUENCE_EMAIL = "user@example.com";
    process.env.CONFLUENCE_API_TOKEN = "tok";
    const { getConfig } = await loadModule();
    const config = await getConfig({
      registry: {
        state: "unreadable",
        reason: { kind: "not-regular-file" },
        path: "/x",
        backup: undefined,
        observed: "absent",
      },
    });
    expect(config.profile).toBeNull();
    expect(mockGetProfileSettings).not.toHaveBeenCalled();
  });
});
