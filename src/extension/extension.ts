import * as vscode from 'vscode';
import { ConfigPanel, ConfigViewProvider } from './webview.js';

// The MCP environment provider API is available at runtime in VS Code 1.96+
// but not yet in @types/vscode. We declare the shape we need here.
interface MCPEnvironmentProvider {
  resolveEnvironment(env: Record<string, string>): Promise<Record<string, string>>;
}
declare module 'vscode' {
  namespace lm {
    function registerMCPServerEnvironmentProvider(
      id: string,
      provider: MCPEnvironmentProvider
    ): vscode.Disposable;
  }
}

export async function activate(context: vscode.ExtensionContext) {
  // Register sidebar webview view provider (Activity Bar icon)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ConfigViewProvider.viewType,
      new ConfigViewProvider(context)
    )
  );

  // Register the configuration webview command (opens in editor area)
  context.subscriptions.push(
    vscode.commands.registerCommand('epimethian-mcp.configure', () => {
      ConfigPanel.createOrShow(context);
    })
  );

  // Register MCP server environment provider
  // Injects credentials from SecretStorage + settings into the server process
  context.subscriptions.push(
    vscode.lm.registerMCPServerEnvironmentProvider('confluence', {
      async resolveEnvironment(env: Record<string, string>) {
        const config = vscode.workspace.getConfiguration('epimethian-mcp');
        const token = await context.secrets.get('epimethian-mcp.apiToken');
        return {
          ...env,
          CONFLUENCE_URL: config.get<string>('url') ?? '',
          CONFLUENCE_EMAIL: config.get<string>('email') ?? '',
          CONFLUENCE_API_TOKEN: token ?? '',
        };
      },
    })
  );
}

export function deactivate() {
  // No-op
}
