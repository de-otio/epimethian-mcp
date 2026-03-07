import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRegisterCommand, mockGet, mockGetConfiguration, mockRegisterMCPServerEnvironmentProvider } = vi.hoisted(() => {
  const mockGet = vi.fn();
  const mockGetConfiguration = vi.fn(() => ({ get: mockGet }));
  const mockRegisterCommand = vi.fn();
  const mockRegisterMCPServerEnvironmentProvider = vi.fn();
  return { mockRegisterCommand, mockGet, mockGetConfiguration, mockRegisterMCPServerEnvironmentProvider };
});

vi.mock('vscode', () => ({
  workspace: { getConfiguration: mockGetConfiguration },
  commands: { registerCommand: mockRegisterCommand },
  window: { activeTextEditor: undefined },
  lm: { registerMCPServerEnvironmentProvider: mockRegisterMCPServerEnvironmentProvider },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { One: 1 },
}));

vi.mock('./webview.js', () => ({
  ConfigPanel: { createOrShow: vi.fn() },
}));

import { activate, deactivate } from './extension.js';

function makeContext() {
  return {
    subscriptions: [] as any[],
    secrets: {
      get: vi.fn().mockResolvedValue('test-token'),
      store: vi.fn(),
    },
  } as any;
}

describe('activate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the configure command', async () => {
    const ctx = makeContext();
    await activate(ctx);

    expect(mockRegisterCommand).toHaveBeenCalledWith(
      'epimethian-mcp.configure',
      expect.any(Function)
    );
    expect(ctx.subscriptions.length).toBe(2);
  });

  it('registers MCP environment provider', async () => {
    const ctx = makeContext();
    await activate(ctx);

    expect(mockRegisterMCPServerEnvironmentProvider).toHaveBeenCalledWith(
      'confluence',
      expect.objectContaining({ resolveEnvironment: expect.any(Function) })
    );
  });
});

describe('MCP env provider resolveEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects url, email, token from config and secrets', async () => {
    const ctx = makeContext();
    mockGet.mockImplementation((key: string) => {
      if (key === 'url') return 'https://my.atlassian.net';
      if (key === 'email') return 'dev@co.com';
      return undefined;
    });
    ctx.secrets.get.mockResolvedValue('my-secret-token');

    await activate(ctx);

    // Get the provider that was registered
    const provider = mockRegisterMCPServerEnvironmentProvider.mock.calls[0][1];
    const result = await provider.resolveEnvironment({ EXISTING: 'val' });

    expect(result).toEqual({
      EXISTING: 'val',
      CONFLUENCE_URL: 'https://my.atlassian.net',
      CONFLUENCE_EMAIL: 'dev@co.com',
      CONFLUENCE_API_TOKEN: 'my-secret-token',
    });
  });
});

describe('deactivate', () => {
  it('is a no-op function', () => {
    expect(deactivate).not.toThrow();
  });
});
