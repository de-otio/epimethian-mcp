/**
 * Gateway-mode setup (scoped API token): order of calls, what is saved, and
 * what must never be saved. The keychain, the network helpers, readline and the
 * profile registry are mocked; the pure `buildKeychainRecord` is the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockTestConnection = vi.fn();
const mockFetchTenantInfo = vi.fn();
const mockProbeWriteScope = vi.fn();
const mockSaveToKeychain = vi.fn().mockResolvedValue(undefined);
const mockReadFromKeychain = vi.fn().mockResolvedValue(null);
const calls: string[] = [];

vi.mock("../shared/test-connection.js", () => ({
  testConnection: (...a: unknown[]) => {
    calls.push("testConnection");
    return mockTestConnection(...a);
  },
  fetchTenantInfo: (...a: unknown[]) => {
    calls.push("fetchTenantInfo");
    return mockFetchTenantInfo(...a);
  },
  probeGatewayWriteScope: (...a: unknown[]) => {
    calls.push("probeWriteScope");
    return mockProbeWriteScope(...a);
  },
}));

vi.mock("../shared/keychain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/keychain.js")>();
  return {
    buildKeychainRecord: actual.buildKeychainRecord,
    saveToKeychain: (...a: unknown[]) => {
      calls.push("save");
      return mockSaveToKeychain(...a);
    },
    readFromKeychain: (...a: unknown[]) => mockReadFromKeychain(...a),
    PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
  };
});

const mockAddToProfileRegistry = vi.fn().mockResolvedValue(undefined);
const mockSetProfileSettings = vi.fn().mockResolvedValue(undefined);
vi.mock("../shared/profiles.js", () => ({
  addToProfileRegistry: (...a: unknown[]) => mockAddToProfileRegistry(...a),
  setProfileSettings: (...a: unknown[]) => mockSetProfileSettings(...a),
}));

const mockQuestion = vi.fn();
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: mockQuestion, close: vi.fn() }),
}));

import { runSetup } from "./setup.js";

const CLOUD_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const GATEWAY = `https://api.atlassian.com/ex/confluence/${CLOUD_ID}`;
const URL_ = "https://example.atlassian.net";

const origExit = process.exit;
const origTTY = process.stdin.isTTY;
const origOn = process.stdin.on;
let logs: string[];

function typeToken(token: string): void {
  process.stdin.on = vi.fn((event: string, cb: (k: string) => void) => {
    if (event === "data") setTimeout(() => [...token, "\n"].forEach((c) => cb(c)), 0);
    return process.stdin;
  }) as never;
  process.stdin.resume = vi.fn().mockReturnValue(process.stdin) as never;
  process.stdin.pause = vi.fn().mockReturnValue(process.stdin) as never;
}

/** url, email, "scoped?" then the prompts that follow, in order. */
function answers(...rest: string[]): void {
  [URL_, "user@example.com", ...rest].forEach((a) => mockQuestion.mockResolvedValueOnce(a));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQuestion.mockReset();
  mockTestConnection.mockReset().mockResolvedValue({ ok: true, message: "Connected successfully." });
  mockFetchTenantInfo
    .mockReset()
    .mockResolvedValue({ ok: true, info: { cloudId: CLOUD_ID, displayName: "Example" } });
  mockProbeWriteScope.mockReset().mockResolvedValue(403);
  mockReadFromKeychain.mockReset().mockResolvedValue(null);
  calls.length = 0;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
  process.stdin.setRawMode = vi.fn().mockReturnValue(process.stdin) as never;
  process.exit = vi.fn((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never;
  typeToken("scoped-token");
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exit = origExit;
  process.stdin.on = origOn;
  Object.defineProperty(process.stdin, "isTTY", { value: origTTY, writable: true });
});

describe("gateway setup", () => {
  it("seals first (unauthenticated), tests through the gateway, then saves mode + cloudId + expiry together", async () => {
    answers("y", "y", "2027-06-30", "1"); // scoped, tenant ok, expiry, read-only
    await runSetup("gw-test");

    // No credentialed call before the tenant is confirmed; the probe comes before the save.
    expect(calls).toEqual(["fetchTenantInfo", "testConnection", "probeWriteScope", "save"]);
    expect(mockFetchTenantInfo).toHaveBeenCalledWith(URL_, "user@example.com", "scoped-token", {
      authenticated: false,
    });
    expect(mockTestConnection).toHaveBeenCalledWith(GATEWAY, "user@example.com", "scoped-token", { gateway: true });
    expect(mockProbeWriteScope).toHaveBeenCalledWith(GATEWAY, "user@example.com", "scoped-token");
    expect(mockSaveToKeychain).toHaveBeenCalledWith(
      {
        url: URL_,
        email: "user@example.com",
        apiToken: "scoped-token",
        cloudId: CLOUD_ID,
        tenantDisplayName: "Example",
        apiMode: "gateway",
        tokenExpiry: "2027-06-30",
      },
      "gw-test",
    );
    expect(mockSetProfileSettings).toHaveBeenCalledWith("gw-test", { posture: "read-only" });
    const out = logs.join("\n");
    expect(out).toContain("read:page:confluence");
    expect(out).toContain("to be confirmed by the live probe");
    expect(out).not.toContain("write:page:confluence"); // read-only posture lists read scopes only
    expect(out).toContain("Not available in gateway mode:");
    expect(out).toContain("add_attachment");
  });

  it("read-write posture lists the write scopes and skips the read-only probe", async () => {
    answers("y", "y", "", "2");
    await runSetup("gw-test");
    expect(logs.join("\n")).toContain("write:page:confluence");
    expect(mockProbeWriteScope).not.toHaveBeenCalled();
    expect(mockSaveToKeychain.mock.calls[0][0]).not.toHaveProperty("tokenExpiry"); // blank expiry: omitted, not ""
  });

  it("a read-only profile whose token can still write is warned, not blocked", async () => {
    mockProbeWriteScope.mockResolvedValue(404);
    answers("y", "y", "", "1");
    await runSetup("gw-test");
    expect(logs.join("\n")).toMatch(/broader than the read-only posture/);
    expect(mockSaveToKeychain).toHaveBeenCalledTimes(1);
  });

  it("without a tenant seal nothing is saved and no credentialed call is made", async () => {
    mockFetchTenantInfo.mockResolvedValue({ ok: false, message: "HTTP 404" });
    answers("y");
    await expect(runSetup("gw-test")).rejects.toThrow("process.exit(1)");
    expect(calls).toEqual(["fetchTenantInfo"]);
    expect(mockSaveToKeychain).not.toHaveBeenCalled();
  });

  it("a tenant_info answer that is not a valid cloudId cannot become a gateway base", async () => {
    mockFetchTenantInfo.mockResolvedValue({ ok: true, info: { cloudId: "../other-tenant", displayName: "X" } });
    answers("y", "y");
    await expect(runSetup("gw-test")).rejects.toThrow("process.exit(1)");
    expect(mockTestConnection).not.toHaveBeenCalled();
    expect(mockSaveToKeychain).not.toHaveBeenCalled();
  });

  it("an unconfirmed tenant aborts before any credentialed call", async () => {
    answers("y", "n");
    await expect(runSetup("gw-test")).rejects.toThrow("process.exit(1)");
    expect(mockTestConnection).not.toHaveBeenCalled();
    expect(mockSaveToKeychain).not.toHaveBeenCalled();
  });

  it("a gateway connection failure saves nothing", async () => {
    mockTestConnection.mockResolvedValue({ ok: false, message: "HTTP 401 from the Atlassian API gateway" });
    answers("y", "y");
    await expect(runSetup("gw-test")).rejects.toThrow("process.exit(1)");
    expect(mockSaveToKeychain).not.toHaveBeenCalled();
  });

  it("needs a named profile: no profile, no token prompt, nothing saved", async () => {
    answers("y");
    await expect(runSetup()).rejects.toThrow("process.exit(1)");
    expect(calls).toEqual([]);
    expect(mockSaveToKeychain).not.toHaveBeenCalled();
  });

  it("re-asks for an expiry that is not a real date", async () => {
    answers("y", "y", "2027-02-30", "tomorrow", "2027-03-01", "1");
    await runSetup("gw-test");
    expect(mockSaveToKeychain.mock.calls[0][0]).toMatchObject({ tokenExpiry: "2027-03-01" });
  });
});

describe("scope probe wording (review D5)", () => {
  it.each([
    [403, /this token cannot update pages/],
    [404, /this token can update pages/],
    [500, /inconclusive/],
  ])("status %i: says what was probed (page updates) and that other write scopes were not", async (status, said) => {
    mockProbeWriteScope.mockResolvedValue(status);
    answers("y", "y", "", "1");
    await runSetup("gw-test");
    const out = logs.join("\n");
    expect(out).toMatch(said);
    expect(out).toMatch(/other write scopes .*were not probed/i);
    expect(out).not.toMatch(/the token cannot write/);
  });
});

describe("gateway setup hardening (review D4)", () => {
  const origArgv = process.argv;
  afterEach(() => {
    process.argv = origArgv;
  });

  it("--yes does not skip the tenant confirmation in gateway mode", async () => {
    process.argv = [...origArgv.slice(0, 2), "setup", "--profile", "gw-test", "--yes"];
    answers("y", "n"); // scoped, then the tenant question is asked and answered "no"
    await expect(runSetup("gw-test")).rejects.toThrow("process.exit(1)");
    expect(mockQuestion.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringMatching(/Is this the tenant you intended/),
    );
    expect(mockTestConnection).not.toHaveBeenCalled();
    expect(mockSaveToKeychain).not.toHaveBeenCalled();
  });

  it("a gateway profile needs an *.atlassian.net site: refused before any request", async () => {
    ["https://wiki.example.com", "user@example.com", "y"].forEach((a) => mockQuestion.mockResolvedValueOnce(a));
    await expect(runSetup("gw-test")).rejects.toThrow("process.exit(1)");
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toMatch(/--allow-non-atlassian-host/);
  });

  it("a lookalike host that only contains atlassian.net is refused too", async () => {
    ["https://example.atlassian.net.evil.example", "user@example.com", "y"].forEach((a) => mockQuestion.mockResolvedValueOnce(a));
    await expect(runSetup("gw-test")).rejects.toThrow("process.exit(1)");
    expect(calls).toEqual([]);
  });

  it("--allow-non-atlassian-host lets a gateway profile use another host", async () => {
    process.argv = [...origArgv.slice(0, 2), "setup", "--profile", "gw-test", "--allow-non-atlassian-host"];
    ["https://wiki.example.com", "user@example.com", "y", "y", "", "2"].forEach((a) => mockQuestion.mockResolvedValueOnce(a));
    await runSetup("gw-test");
    expect(calls[0]).toBe("fetchTenantInfo");
    expect(mockSaveToKeychain).toHaveBeenCalledTimes(1);
  });

  it("site mode with a non-atlassian host is still only a warning", async () => {
    ["https://wiki.example.com", "user@example.com", "n", "y", "1"].forEach((a) => mockQuestion.mockResolvedValueOnce(a));
    await runSetup("site-test");
    expect(mockSaveToKeychain).toHaveBeenCalledTimes(1);
  });

  it("control characters in the tenant name are stripped before printing", async () => {
    mockFetchTenantInfo.mockResolvedValue({
      ok: true,
      info: { cloudId: CLOUD_ID, displayName: "Exa\u001b[2Jmple\r\u202eKO\u0007" },
    });
    answers("y", "y", "", "2");
    await runSetup("gw-test");
    const out = logs.join("\n");
    expect(out).toContain("Exa[2JmpleKO");
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f\u202e]/);
  });
});

describe("site setup is unchanged", () => {
  it("answering no to 'scoped?' never writes apiMode or tokenExpiry", async () => {
    mockFetchTenantInfo.mockResolvedValue({ ok: true, info: { cloudId: CLOUD_ID, displayName: "Example" } });
    answers("n", "y", "1");
    await runSetup("site-test");
    const saved = mockSaveToKeychain.mock.calls[0][0] as Record<string, unknown>;
    expect(saved).not.toHaveProperty("apiMode");
    expect(saved).not.toHaveProperty("tokenExpiry");
    expect(mockTestConnection).toHaveBeenCalledWith(URL_, "user@example.com", "scoped-token");
    expect(mockFetchTenantInfo).toHaveBeenCalledWith(URL_, "user@example.com", "scoped-token");
  });
});
