import * as vscode from 'vscode';
import { loadCredentials, saveCredentials, testConnection } from './config.js';
import {
  getSupportedClients,
  registerServer,
  unregisterServer,
  isServerRegistered,
} from './mcp-clients.js';
import type { ClientStatus } from '../shared/types.js';

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
      'Confluence MCP: Configure',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    ConfigPanel.currentPanel = new ConfigPanel(context, panel);
  }

  private constructor(context: vscode.ExtensionContext, panel: vscode.WebviewPanel) {
    this.context = context;
    this.panel = panel;

    this.panel.webview.html = this.getHtmlContent();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
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

  private async getClientStatuses(): Promise<ClientStatus[]> {
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

  private async handleMessage(msg: { type: string; url?: string; email?: string; apiToken?: string; clientId?: string }): Promise<void> {
    switch (msg.type) {
      case 'requestConfig': {
        const creds = await loadCredentials(this.context);
        const clients = await this.getClientStatuses();
        await this.panel.webview.postMessage({
          type: 'configLoaded',
          url: creds.url,
          email: creds.email,
          hasToken: creds.apiToken.length > 0,
          clients,
        });
        break;
      }
      case 'save': {
        await saveCredentials(this.context, msg.url ?? '', msg.email ?? '', msg.apiToken ?? '');
        await this.panel.webview.postMessage({ type: 'saved' });
        break;
      }
      case 'testConnection': {
        const result = await testConnection(msg.url ?? '', msg.email ?? '', msg.apiToken ?? '');
        if (result.ok) {
          await this.context.globalState.update(
            'epimethian-mcp.lastVerified',
            new Date().toISOString()
          );
        }
        await this.panel.webview.postMessage({
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
          const creds = await loadCredentials(this.context);
          const env: Record<string, string> = {
            CONFLUENCE_URL: creds.url,
            CONFLUENCE_EMAIL: creds.email,
            CONFLUENCE_API_TOKEN: creds.apiToken,
          };
          await registerServer(client, this.context.extensionPath, env);
        }
        const clients = await this.getClientStatuses();
        await this.panel.webview.postMessage({ type: 'clientUpdated', clients });
        break;
      }
      case 'unregisterClient': {
        const clientId = msg.clientId ?? '';
        const client = getSupportedClients().find((c) => c.id === clientId);
        if (client) {
          await unregisterServer(client);
        }
        const clients = await this.getClientStatuses();
        await this.panel.webview.postMessage({ type: 'clientUpdated', clients });
        break;
      }
    }
  }

  private getHtmlContent(): string {
    const nonce = getNonce();
    const lastVerified = this.context.globalState.get<string>('epimethian-mcp.lastVerified');
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
  <title>Confluence MCP Configuration</title>
  <style nonce="${nonce}">
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      padding: 20px;
      max-width: 500px;
    }
    label { display: block; margin-top: 12px; font-weight: bold; }
    input {
      width: 100%;
      padding: 6px 8px;
      margin-top: 4px;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
    }
    button {
      margin-top: 16px;
      margin-right: 8px;
      padding: 6px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #status {
      margin-top: 16px;
      padding: 8px;
      border-radius: 2px;
    }
    .ok { background: var(--vscode-inputValidation-infoBackground); }
    .err { background: var(--vscode-inputValidation-errorBackground); }
    a { color: var(--vscode-textLink-foreground); }
    .hint { font-size: 0.85em; margin-top: 4px; opacity: 0.8; }
    h3 { margin-top: 24px; margin-bottom: 8px; }
    .client-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0;
      border-bottom: 1px solid var(--vscode-widget-border, #333);
    }
    .client-info { flex: 1; }
    .client-name { font-weight: bold; }
    .client-path { font-size: 0.8em; opacity: 0.7; }
    .client-row button { margin-top: 0; font-size: 0.85em; padding: 3px 10px; }
  </style>
</head>
<body>
  <h2>Confluence MCP Configuration</h2>

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
  <p class="hint">Register the Confluence MCP server with your AI tools. Each client's config file is updated in place — existing entries are preserved.</p>
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
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
