import * as vscode from 'vscode';
import { loadCredentials, saveCredentials, testConnection } from './config.js';
import {
  getSupportedClients,
  registerServer,
  unregisterServer,
  isServerRegistered,
} from './mcp-clients.js';
import type { ClientStatus } from '../shared/types.js';

// --- Shared message handling and HTML generation ---

async function getClientStatuses(): Promise<ClientStatus[]> {
  const clients = getSupportedClients();
  return Promise.all(
    clients.map(async (c) => ({
      id: c.id,
      name: c.name,
      pathDescription: c.pathDescription,
      registered: await isServerRegistered(c),
    }))
  );
}

async function handleMessage(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  msg: { type: string; url?: string; email?: string; apiToken?: string; clientId?: string },
): Promise<void> {
  switch (msg.type) {
    case 'requestConfig': {
      const creds = await loadCredentials(context);
      const clients = await getClientStatuses();
      await webview.postMessage({
        type: 'configLoaded',
        url: creds.url,
        email: creds.email,
        hasToken: creds.apiToken.length > 0,
        clients,
      });
      break;
    }
    case 'save': {
      await saveCredentials(context, msg.url ?? '', msg.email ?? '', msg.apiToken ?? '');
      await webview.postMessage({ type: 'saved' });
      break;
    }
    case 'testConnection': {
      const result = await testConnection(msg.url ?? '', msg.email ?? '', msg.apiToken ?? '');
      if (result.ok) {
        await context.globalState.update(
          'epimethian-mcp.lastVerified',
          new Date().toISOString()
        );
      }
      await webview.postMessage({
        type: 'testResult',
        ok: result.ok,
        message: result.message,
      });
      break;
    }
    case 'registerClient': {
      const clientId = msg.clientId ?? '';
      const client = getSupportedClients().find((c) => c.id === clientId);
      if (client) {
        await registerServer(client, context.extensionPath);
      }
      const clients = await getClientStatuses();
      await webview.postMessage({ type: 'clientUpdated', clients });
      break;
    }
    case 'unregisterClient': {
      const clientId = msg.clientId ?? '';
      const client = getSupportedClients().find((c) => c.id === clientId);
      if (client) {
        await unregisterServer(client);
      }
      const clients = await getClientStatuses();
      await webview.postMessage({ type: 'clientUpdated', clients });
      break;
    }
  }
}

function getHtmlContent(context: vscode.ExtensionContext): string {
  const nonce = getNonce();
  const lastVerified = context.globalState.get<string>('epimethian-mcp.lastVerified');
  const lastVerifiedDisplay = lastVerified
    ? new Date(lastVerified).toLocaleString()
    : 'Never';

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Epimethian MCP Configuration</title>
  <style nonce="${nonce}">
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      padding: 12px;
    }
    label { display: block; margin-top: 10px; font-weight: bold; font-size: 0.9em; }
    input {
      width: 100%;
      padding: 5px 7px;
      margin-top: 3px;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      font-size: 0.9em;
    }
    button {
      margin-top: 12px;
      margin-right: 6px;
      padding: 5px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: 0.85em;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #status {
      margin-top: 12px;
      padding: 6px;
      border-radius: 2px;
      font-size: 0.85em;
    }
    .ok { background: var(--vscode-inputValidation-infoBackground); }
    .err { background: var(--vscode-inputValidation-errorBackground); }
    a { color: var(--vscode-textLink-foreground); }
    .hint { font-size: 0.8em; margin-top: 3px; opacity: 0.8; }
    h3 { margin-top: 20px; margin-bottom: 6px; font-size: 1em; }
    .client-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 0;
      border-bottom: 1px solid var(--vscode-widget-border, #333);
    }
    .client-info { flex: 1; min-width: 0; }
    .client-name { font-weight: bold; font-size: 0.85em; }
    .client-path { font-size: 0.75em; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .client-row button { margin-top: 0; font-size: 0.8em; padding: 2px 8px; flex-shrink: 0; }
  </style>
</head>
<body>
  <label for="url">Confluence URL</label>
  <input id="url" type="text" placeholder="https://yourcompany.atlassian.net" />

  <label for="email">Email</label>
  <input id="email" type="text" placeholder="you@company.com" />

  <label for="apiToken">API Token</label>
  <input id="apiToken" type="password" placeholder="Paste your API token" />
  <div class="hint">
    <a href="https://id.atlassian.com/manage-profile/security/api-tokens">Generate a token</a>
  </div>

  <div>
    <button id="testBtn">Test Connection</button>
    <button id="saveBtn">Save</button>
  </div>

  <div id="status"></div>
  <div class="hint">Last verified: <span id="lastVerified">${lastVerifiedDisplay}</span></div>

  <h3>AI Clients</h3>
  <p class="hint">Register the Epimethian MCP server with your AI tools. Config files are updated in place.</p>
  <div id="clients"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const urlInput = document.getElementById('url');
    const emailInput = document.getElementById('email');
    const tokenInput = document.getElementById('apiToken');
    const statusDiv = document.getElementById('status');
    const lastVerifiedSpan = document.getElementById('lastVerified');
    const clientsDiv = document.getElementById('clients');

    vscode.postMessage({ type: 'requestConfig' });

    document.getElementById('saveBtn').addEventListener('click', () => {
      vscode.postMessage({
        type: 'save',
        url: urlInput.value,
        email: emailInput.value,
        apiToken: tokenInput.value,
      });
    });

    document.getElementById('testBtn').addEventListener('click', () => {
      statusDiv.textContent = 'Testing...';
      statusDiv.className = '';
      vscode.postMessage({
        type: 'testConnection',
        url: urlInput.value,
        email: emailInput.value,
        apiToken: tokenInput.value,
      });
    });

    function renderClients(clients) {
      clientsDiv.innerHTML = '';
      for (const c of clients) {
        const row = document.createElement('div');
        row.className = 'client-row';
        row.innerHTML =
          '<div class="client-info">' +
            '<div class="client-name">' + c.name + '</div>' +
            '<div class="client-path">' + c.pathDescription + '</div>' +
          '</div>';
        const btn = document.createElement('button');
        if (c.registered) {
          btn.textContent = 'Remove';
          btn.className = 'btn-secondary';
          btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'unregisterClient', clientId: c.id });
          });
        } else {
          btn.textContent = 'Register';
          btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'registerClient', clientId: c.id });
          });
        }
        row.appendChild(btn);
        clientsDiv.appendChild(row);
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'configLoaded':
          urlInput.value = msg.url || '';
          emailInput.value = msg.email || '';
          tokenInput.placeholder = msg.hasToken ? '(token saved)' : 'Paste your API token';
          if (msg.clients) renderClients(msg.clients);
          break;
        case 'saved':
          statusDiv.textContent = 'Credentials saved.';
          statusDiv.className = 'ok';
          break;
        case 'testResult':
          statusDiv.textContent = msg.message;
          statusDiv.className = msg.ok ? 'ok' : 'err';
          if (msg.ok) {
            lastVerifiedSpan.textContent = new Date().toLocaleString();
          }
          break;
        case 'clientUpdated':
          renderClients(msg.clients);
          break;
      }
    });
  </script>
</body>
</html>`;
}

// --- Sidebar WebviewViewProvider (Activity Bar icon) ---

export class ConfigViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'epimethian-mcp.configView';

  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _resolveContext: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getHtmlContent(this.context);
    webviewView.webview.onDidReceiveMessage((msg) =>
      handleMessage(this.context, webviewView.webview, msg)
    );
  }
}

// --- Editor Panel (Command Palette) ---

export class ConfigPanel {
  private static currentPanel: ConfigPanel | undefined;
  private static readonly viewType = 'epimethianMcpConfig';

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];

  static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (ConfigPanel.currentPanel) {
      ConfigPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      ConfigPanel.viewType,
      'Epimethian MCP: Configure',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    ConfigPanel.currentPanel = new ConfigPanel(context, panel);
  }

  private constructor(context: vscode.ExtensionContext, panel: vscode.WebviewPanel) {
    this.context = context;
    this.panel = panel;

    this.panel.webview.html = getHtmlContent(this.context);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg) => handleMessage(this.context, this.panel.webview, msg),
      null,
      this.disposables
    );
  }

  private dispose(): void {
    ConfigPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
