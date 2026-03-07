import * as vscode from 'vscode';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * Each AI client stores its MCP server config in a different location
 * and with a slightly different schema. This module knows how to
 * safely read, merge, and write each one.
 */

export interface McpClientInfo {
  /** Display name shown in the webview */
  name: string;
  /** Unique identifier */
  id: string;
  /** Absolute path to the config file */
  configPath: string;
  /** Description of where the file lives */
  pathDescription: string;
}

/** The server entry we write into each client's config */
interface ServerEntry {
  command: string;
  args: string[];
}

function buildServerEntry(extensionPath: string): ServerEntry {
  return {
    command: 'node',
    args: [join(extensionPath, 'dist', 'server.js')],
  };
}

const home = homedir();

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function getSupportedClients(): McpClientInfo[] {
  return [
    {
      name: 'Claude Code',
      id: 'claude',
      configPath: getWorkspaceRoot()
        ? join(getWorkspaceRoot()!, '.mcp.json')
        : join(home, '.claude', 'mcp.json'),
      pathDescription: getWorkspaceRoot()
        ? '<workspace>/.mcp.json'
        : '~/.claude/mcp.json',
    },
    {
      name: 'Claude Desktop',
      id: 'claude-desktop',
      configPath: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      pathDescription: '~/Library/Application Support/Claude/claude_desktop_config.json',
    },
    {
      name: 'ChatGPT',
      id: 'chatgpt',
      configPath: join(home, '.chatgpt', 'mcp.json'),
      pathDescription: '~/.chatgpt/mcp.json',
    },
    {
      name: 'Continue',
      id: 'continue',
      configPath: join(home, '.continue', 'mcp.json'),
      pathDescription: '~/.continue/mcp.json',
    },
    {
      name: 'Kilo Code',
      id: 'kilo',
      configPath: join(home, '.kilo', 'mcp.json'),
      pathDescription: '~/.kilo/mcp.json',
    },
  ];
}

/**
 * Read an existing JSON config file, returning {} if it doesn't exist.
 * Never overwrites — always merges.
 */
async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Write a JSON config file, creating parent directories if needed.
 */
async function writeJsonFile(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Ensure `.mcp.json` is listed in the workspace .gitignore.
 */
async function ensureGitignore(workspaceRoot: string): Promise<void> {
  const gitignorePath = join(workspaceRoot, '.gitignore');
  let content = '';
  try {
    content = await readFile(gitignorePath, 'utf-8');
  } catch {
    // .gitignore doesn't exist yet — we'll create it
  }
  const lines = content.split('\n');
  if (lines.some((line) => line.trim() === '.mcp.json')) {
    return;
  }
  const newline = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  await writeFile(gitignorePath, content + newline + '.mcp.json\n', 'utf-8');
}

/**
 * Register the confluence MCP server in a client's config file.
 * Merges into the existing file — never overwrites other servers.
 */
export async function registerServer(
  client: McpClientInfo,
  extensionPath: string,
): Promise<void> {
  const existing = await readJsonFile(client.configPath);
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  servers.confluence = buildServerEntry(extensionPath);
  existing.mcpServers = servers;
  await writeJsonFile(client.configPath, existing);

  // For Claude Code with project-level config, ensure .mcp.json is gitignored
  if (client.id === 'claude') {
    const workspaceRoot = getWorkspaceRoot();
    if (workspaceRoot && client.configPath.startsWith(workspaceRoot)) {
      await ensureGitignore(workspaceRoot);
    }
  }
}

/**
 * Remove the confluence MCP server from a client's config file.
 * Preserves all other servers and top-level keys.
 */
export async function unregisterServer(client: McpClientInfo): Promise<void> {
  const existing = await readJsonFile(client.configPath);
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  delete servers.confluence;
  existing.mcpServers = servers;
  await writeJsonFile(client.configPath, existing);
}

/**
 * Check if the confluence server is registered in a client's config.
 */
export async function isServerRegistered(client: McpClientInfo): Promise<boolean> {
  const existing = await readJsonFile(client.configPath);
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  return 'confluence' in servers;
}
