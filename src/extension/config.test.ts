import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockGet, mockUpdate, mockGetConfiguration } = vi.hoisted(() => {
  const mockGet = vi.fn();
  const mockUpdate = vi.fn();
  const mockGetConfiguration = vi.fn(() => ({ get: mockGet, update: mockUpdate }));
  return { mockGet, mockUpdate, mockGetConfiguration };
});

vi.mock('vscode', () => ({
  workspace: { getConfiguration: mockGetConfiguration },
  ConfigurationTarget: { Global: 1 },
}));

const mockSaveToKeychain = vi.fn().mockResolvedValue(undefined);
vi.mock('../shared/keychain.js', () => ({
  saveToKeychain: (...args: unknown[]) => mockSaveToKeychain(...args),
}));

import { saveCredentials, loadCredentials, testConnection } from './config.js';

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    secrets: {
      store: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(''),
    },
    ...overrides,
  } as any;
}

describe('saveCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue(undefined);
  });

  it('updates url and email in config with Global target, stores token in secrets', async () => {
    const ctx = makeContext();
    await saveCredentials(ctx, 'https://example.atlassian.net', 'user@example.com', 'tok123');

    expect(mockGetConfiguration).toHaveBeenCalledWith('epimethian-mcp');
    expect(mockUpdate).toHaveBeenCalledWith('url', 'https://example.atlassian.net', 1);
    expect(mockUpdate).toHaveBeenCalledWith('email', 'user@example.com', 1);
    expect(ctx.secrets.store).toHaveBeenCalledWith('epimethian-mcp.apiToken', 'tok123');
  });
});

describe('loadCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads url and email from config, token from secrets', async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === 'url') return 'https://my.atlassian.net';
      if (key === 'email') return 'me@test.com';
      return undefined;
    });
    const ctx = makeContext();
    ctx.secrets.get.mockResolvedValue('secret-token');

    const result = await loadCredentials(ctx);

    expect(result).toEqual({
      url: 'https://my.atlassian.net',
      email: 'me@test.com',
      apiToken: 'secret-token',
    });
    expect(ctx.secrets.get).toHaveBeenCalledWith('epimethian-mcp.apiToken');
  });

  it('returns empty strings when nothing is configured', async () => {
    mockGet.mockReturnValue(undefined);
    const ctx = makeContext();
    ctx.secrets.get.mockResolvedValue(undefined);

    const result = await loadCredentials(ctx);

    expect(result).toEqual({ url: '', email: '', apiToken: '' });
  });
});

describe('testConnection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success with space name on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ name: 'Engineering' }] }),
    } as any);

    const result = await testConnection('https://x.atlassian.net', 'a@b.com', 'tok');

    expect(result.ok).toBe(true);
    expect(result.message).toContain('Connected');
    expect(result.message).toContain('Engineering');
  });

  it('returns failure with "invalid or expired" on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    } as any);

    const result = await testConnection('https://x.atlassian.net', 'a@b.com', 'bad');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('invalid or expired');
  });

  it('returns failure with HTTP status on other errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    } as any);

    const result = await testConnection('https://x.atlassian.net', 'a@b.com', 'tok');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('403');
  });

  it('returns failure with "Connection failed" on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await testConnection('https://x.atlassian.net', 'a@b.com', 'tok');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Connection failed');
  });
});
