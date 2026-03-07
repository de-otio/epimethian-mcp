import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mock state ---
let onDidReceiveMessageCallback: ((msg: any) => void) | undefined;
let onDidDisposeCallback: (() => void) | undefined;

const mockPostMessage = vi.fn().mockResolvedValue(true);
const mockReveal = vi.fn();
const mockPanelDispose = vi.fn();

const mockPanel = {
  webview: {
    html: '',
    postMessage: mockPostMessage,
    onDidReceiveMessage: vi.fn((cb: any) => {
      onDidReceiveMessageCallback = cb;
      return { dispose: vi.fn() };
    }),
  },
  onDidDispose: vi.fn((cb: any) => {
    onDidDisposeCallback = cb;
    return { dispose: vi.fn() };
  }),
  reveal: mockReveal,
  dispose: mockPanelDispose,
};

const mockCreateWebviewPanel = vi.fn(() => mockPanel);

vi.mock('vscode', () => ({
  workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn(), update: vi.fn() })) },
  window: {
    createWebviewPanel: (...args: unknown[]) => mockCreateWebviewPanel(...args),
    activeTextEditor: undefined,
  },
  commands: { registerCommand: vi.fn() },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { One: 1 },
  Uri: { file: vi.fn((f: string) => ({ fsPath: f })) },
}));

const mockLoadCredentials = vi.fn();
const mockSaveCredentials = vi.fn();
const mockTestConnection = vi.fn();

vi.mock('./config.js', () => ({
  loadCredentials: (...args: unknown[]) => mockLoadCredentials(...args),
  saveCredentials: (...args: unknown[]) => mockSaveCredentials(...args),
  testConnection: (...args: unknown[]) => mockTestConnection(...args),
}));

const mockGetSupportedClients = vi.fn();
const mockRegisterServer = vi.fn();
const mockUnregisterServer = vi.fn();
const mockIsServerRegistered = vi.fn();

vi.mock('./mcp-clients.js', () => ({
  getSupportedClients: (...args: unknown[]) => mockGetSupportedClients(...args),
  registerServer: (...args: unknown[]) => mockRegisterServer(...args),
  unregisterServer: (...args: unknown[]) => mockUnregisterServer(...args),
  isServerRegistered: (...args: unknown[]) => mockIsServerRegistered(...args),
}));

import { ConfigPanel, ConfigViewProvider } from './webview.js';

function makeContext() {
  return {
    extensionPath: '/ext/path',
    secrets: {
      get: vi.fn().mockResolvedValue(''),
      store: vi.fn().mockResolvedValue(undefined),
    },
    globalState: {
      get: vi.fn().mockReturnValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

const defaultClients = [
  { id: 'claude', name: 'Claude Code', configPath: '/home/.claude/mcp.json', pathDescription: '~/.claude/mcp.json' },
];

function setupClientMocks() {
  mockGetSupportedClients.mockReturnValue(defaultClients);
  mockIsServerRegistered.mockResolvedValue(false);
}

describe('ConfigPanel.createOrShow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the static currentPanel by disposing if needed
    onDidReceiveMessageCallback = undefined;
    onDidDisposeCallback = undefined;
    // Reset the static state by triggering dispose
    if (onDidDisposeCallback) {
      onDidDisposeCallback();
    }
    // Force reset static state by accessing internal — we simulate fresh state
    // by calling createOrShow, disposing, then testing again
    (ConfigPanel as any).currentPanel = undefined;
    setupClientMocks();
  });

  it('creates a new webview panel on first call', () => {
    const ctx = makeContext();
    ConfigPanel.createOrShow(ctx);

    expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(1);
    expect(mockCreateWebviewPanel).toHaveBeenCalledWith(
      'epimethianMcpConfig',
      'Epimethian MCP: Configure',
      1,
      expect.objectContaining({ enableScripts: true })
    );
  });

  it('reveals existing panel on second call', () => {
    const ctx = makeContext();
    ConfigPanel.createOrShow(ctx);
    mockCreateWebviewPanel.mockClear();

    ConfigPanel.createOrShow(ctx);

    expect(mockCreateWebviewPanel).not.toHaveBeenCalled();
    expect(mockReveal).toHaveBeenCalled();
  });
});

describe('handleMessage', () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    (ConfigPanel as any).currentPanel = undefined;
    onDidReceiveMessageCallback = undefined;
    setupClientMocks();
    mockLoadCredentials.mockResolvedValue({ url: 'https://x.atlassian.net', email: 'a@b.com', apiToken: 'tok' });
    mockSaveCredentials.mockResolvedValue(undefined);
    mockTestConnection.mockResolvedValue({ ok: true, message: 'Connected successfully. Found space "Dev".' });
    mockRegisterServer.mockResolvedValue(undefined);
    mockUnregisterServer.mockResolvedValue(undefined);

    ctx = makeContext();
    ConfigPanel.createOrShow(ctx);
  });

  it('requestConfig: calls loadCredentials, posts configLoaded with clients', async () => {
    await onDidReceiveMessageCallback!({ type: 'requestConfig' });

    expect(mockLoadCredentials).toHaveBeenCalledWith(ctx);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'configLoaded',
        url: 'https://x.atlassian.net',
        email: 'a@b.com',
        hasToken: true,
        clients: expect.any(Array),
      })
    );
  });

  it('save: calls saveCredentials, posts saved', async () => {
    await onDidReceiveMessageCallback!({
      type: 'save',
      url: 'https://new.atlassian.net',
      email: 'new@b.com',
      apiToken: 'newtoken',
    });

    expect(mockSaveCredentials).toHaveBeenCalledWith(ctx, 'https://new.atlassian.net', 'new@b.com', 'newtoken');
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'saved' });
  });

  it('testConnection: calls testConnection, posts testResult, updates globalState on success', async () => {
    await onDidReceiveMessageCallback!({
      type: 'testConnection',
      url: 'https://x.atlassian.net',
      email: 'a@b.com',
      apiToken: 'tok',
    });

    expect(mockTestConnection).toHaveBeenCalledWith('https://x.atlassian.net', 'a@b.com', 'tok');
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'testResult',
        ok: true,
        message: expect.stringContaining('Connected'),
      })
    );
    expect(ctx.globalState.update).toHaveBeenCalledWith(
      'epimethian-mcp.lastVerified',
      expect.any(String)
    );
  });

  it('testConnection: does not update globalState on failure', async () => {
    mockTestConnection.mockResolvedValue({ ok: false, message: 'Token is invalid or expired' });

    await onDidReceiveMessageCallback!({
      type: 'testConnection',
      url: 'https://x.atlassian.net',
      email: 'a@b.com',
      apiToken: 'bad',
    });

    expect(ctx.globalState.update).not.toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'testResult', ok: false })
    );
  });

  it('registerClient: calls registerServer without env, posts clientUpdated', async () => {
    await onDidReceiveMessageCallback!({ type: 'registerClient', clientId: 'claude' });

    expect(mockRegisterServer).toHaveBeenCalledWith(
      defaultClients[0],
      '/ext/path',
    );
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'clientUpdated', clients: expect.any(Array) })
    );
  });

  it('unregisterClient: calls unregisterServer, posts clientUpdated', async () => {
    await onDidReceiveMessageCallback!({ type: 'unregisterClient', clientId: 'claude' });

    expect(mockUnregisterServer).toHaveBeenCalledWith(defaultClients[0]);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'clientUpdated', clients: expect.any(Array) })
    );
  });
});

describe('ConfigViewProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupClientMocks();
    mockLoadCredentials.mockResolvedValue({ url: '', email: '', apiToken: '' });
  });

  it('resolveWebviewView sets HTML and wires up message handler', () => {
    const ctx = makeContext();
    const provider = new ConfigViewProvider(ctx);

    let sidebarMessageCallback: ((msg: any) => void) | undefined;
    const sidebarWebview = {
      options: {} as any,
      html: '',
      postMessage: vi.fn().mockResolvedValue(true),
      onDidReceiveMessage: vi.fn((cb: any) => {
        sidebarMessageCallback = cb;
        return { dispose: vi.fn() };
      }),
    };
    const webviewView = { webview: sidebarWebview } as any;

    provider.resolveWebviewView(webviewView, {} as any, {} as any);

    expect(sidebarWebview.options.enableScripts).toBe(true);
    expect(sidebarWebview.html).toContain('Confluence URL');
    expect(sidebarWebview.onDidReceiveMessage).toHaveBeenCalled();
    expect(sidebarMessageCallback).toBeDefined();
  });
});
