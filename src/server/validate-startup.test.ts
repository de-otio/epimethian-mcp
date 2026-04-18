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

vi.mock("../shared/profiles.js", () => ({
  getProfileSettings: (...args: unknown[]) => mockGetProfileSettings(...args),
}));

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

  it("does not hard-fail when tenant_info is unreachable (graceful degrade)", async () => {
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
