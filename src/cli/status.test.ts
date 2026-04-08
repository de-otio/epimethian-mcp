import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTestConnection = vi.fn();
const mockReadFromKeychain = vi.fn();

vi.mock("../shared/test-connection.js", () => ({
  testConnection: (...args: unknown[]) => mockTestConnection(...args),
}));

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: (...args: unknown[]) => mockReadFromKeychain(...args),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

import { runStatus } from "./status.js";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CONFLUENCE_PROFILE;
  delete process.env.CONFLUENCE_URL;
  delete process.env.CONFLUENCE_EMAIL;
  delete process.env.CONFLUENCE_API_TOKEN;
});

describe("runStatus", () => {
  it("shows profile info and connection status", async () => {
    process.env.CONFLUENCE_PROFILE = "jambit";
    mockReadFromKeychain.mockResolvedValue({
      url: "https://jambit.atlassian.net",
      email: "user@jambit.com",
      apiToken: "tok",
    });
    mockTestConnection.mockResolvedValue({
      ok: true,
      message: "Connected successfully.",
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runStatus();

    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("jambit");
    expect(output).toContain("jambit.atlassian.net");
    expect(output).toContain("user@jambit.com");
    expect(output).toContain("Connected");
    spy.mockRestore();
  });

  it("shows env-var mode when all three env vars set", async () => {
    process.env.CONFLUENCE_URL = "https://ci.atlassian.net";
    process.env.CONFLUENCE_EMAIL = "ci@test.com";
    process.env.CONFLUENCE_API_TOKEN = "ci-tok";
    mockTestConnection.mockResolvedValue({
      ok: true,
      message: "Connected.",
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runStatus();

    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("env-var mode");
    spy.mockRestore();
  });
});
