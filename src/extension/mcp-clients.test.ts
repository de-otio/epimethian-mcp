import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

import {
  getSupportedClients,
  registerServer,
  unregisterServer,
  isServerRegistered,
  type McpClientInfo,
} from './mcp-clients.js';

function makeClient(overrides: Partial<McpClientInfo> = {}): McpClientInfo {
  return {
    id: 'test-client',
    name: 'Test Client',
    configPath: '/home/user/.test/mcp.json',
    pathDescription: '~/.test/mcp.json',
    ...overrides,
  };
}

describe('getSupportedClients', () => {
  it('returns an array of known clients', () => {
    const clients = getSupportedClients();
    expect(Array.isArray(clients)).toBe(true);
    expect(clients.length).toBeGreaterThan(0);
    for (const c of clients) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('name');
      expect(c).toHaveProperty('configPath');
      expect(c).toHaveProperty('pathDescription');
    }
  });

  it('includes claude and claude-desktop', () => {
    const ids = getSupportedClients().map((c) => c.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('claude-desktop');
  });
});

describe('registerServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  it('creates new structure when file does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const client = makeClient();
    await registerServer(client, '/ext/path', { CONFLUENCE_URL: 'https://x.atlassian.net' });

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [path, content] = mockWriteFile.mock.calls[0];
    expect(path).toBe('/home/user/.test/mcp.json');
    const written = JSON.parse(content);
    expect(written.mcpServers.confluence).toEqual({
      command: 'node',
      args: ['/ext/path/dist/server.js'],
      env: { CONFLUENCE_URL: 'https://x.atlassian.net' },
    });
  });

  it('preserves existing servers when adding confluence', async () => {
    const existing = {
      mcpServers: {
        'other-server': { command: 'python', args: ['serve.py'], env: {} },
      },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(existing));

    const client = makeClient();
    await registerServer(client, '/ext', { KEY: 'VAL' });

    const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
    expect(written.mcpServers['other-server']).toEqual(existing.mcpServers['other-server']);
    expect(written.mcpServers.confluence).toBeDefined();
    expect(written.mcpServers.confluence.command).toBe('node');
  });

  it('overwrites old confluence entry', async () => {
    const existing = {
      mcpServers: {
        confluence: { command: 'old', args: ['old.js'], env: {} },
        other: { command: 'keep', args: [], env: {} },
      },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(existing));

    const client = makeClient();
    await registerServer(client, '/new/path', { A: 'B' });

    const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
    expect(written.mcpServers.confluence.command).toBe('node');
    expect(written.mcpServers.confluence.args).toEqual(['/new/path/dist/server.js']);
    expect(written.mcpServers.other).toEqual(existing.mcpServers.other);
  });

  it('preserves top-level keys beyond mcpServers', async () => {
    const existing = {
      someOtherKey: 'important',
      mcpServers: {},
    };
    mockReadFile.mockResolvedValue(JSON.stringify(existing));

    const client = makeClient();
    await registerServer(client, '/ext', {});

    const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
    expect(written.someOtherKey).toBe('important');
    expect(written.mcpServers.confluence).toBeDefined();
  });
});

describe('unregisterServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  it('removes confluence entry and preserves other servers', async () => {
    const existing = {
      mcpServers: {
        confluence: { command: 'node', args: ['server.js'], env: {} },
        other: { command: 'python', args: ['main.py'], env: {} },
      },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(existing));

    const client = makeClient();
    await unregisterServer(client);

    const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
    expect(written.mcpServers.confluence).toBeUndefined();
    expect(written.mcpServers.other).toEqual(existing.mcpServers.other);
  });

  it('handles file that does not exist gracefully', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const client = makeClient();
    await unregisterServer(client);

    const written = JSON.parse(mockWriteFile.mock.calls[0][1]);
    expect(written.mcpServers).toBeDefined();
    expect(written.mcpServers.confluence).toBeUndefined();
  });
});

describe('isServerRegistered', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when confluence is present', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ mcpServers: { confluence: { command: 'node' } } })
    );
    const result = await isServerRegistered(makeClient());
    expect(result).toBe(true);
  });

  it('returns false when confluence is absent', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ mcpServers: { other: { command: 'python' } } })
    );
    const result = await isServerRegistered(makeClient());
    expect(result).toBe(false);
  });

  it('returns false when file does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const result = await isServerRegistered(makeClient());
    expect(result).toBe(false);
  });
});
