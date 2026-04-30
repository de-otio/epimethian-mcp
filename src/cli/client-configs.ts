export interface ClientConfigEntry {
  /** Stable id used as the --client value (e.g. "opencode"). */
  id: string;
  /** Human-readable display name (e.g. "OpenCode"). */
  displayName: string;
  /** Path hint shown to the user (e.g. "opencode.json or ~/.config/opencode/opencode.json"). */
  configFileHint: string;
  /** JSON template with {{PROFILE}} and {{BIN}} placeholders. */
  template: string;
  /** Optional safety warning rendered after the template. */
  warning?: string;
}

export const CLIENT_CONFIGS: readonly ClientConfigEntry[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    configFileHint: ".mcp.json",
    template: JSON.stringify(
      {
        mcpServers: {
          "epimethian-mcp": {
            command: "{{BIN}}",
            args: ["--profile", "{{PROFILE}}"],
          },
        },
      },
      null,
      2
    ),
  },
  {
    id: "claude-desktop",
    displayName: "Claude Desktop",
    configFileHint:
      "~/Library/Application Support/Claude/claude_desktop_config.json (macOS) / %APPDATA%\\Claude\\claude_desktop_config.json (Windows) / ~/.config/Claude/claude_desktop_config.json (Linux)",
    template: JSON.stringify(
      {
        mcpServers: {
          "epimethian-mcp": {
            command: "{{BIN}}",
            args: ["--profile", "{{PROFILE}}"],
          },
        },
      },
      null,
      2
    ),
  },
  {
    id: "claude-code-vscode",
    displayName: "Claude Code (VS Code extension)",
    configFileHint: "VS Code settings.json (mcp.servers block)",
    template: JSON.stringify(
      {
        "mcp.servers": {
          "epimethian-mcp": {
            command: "{{BIN}}",
            args: ["--profile", "{{PROFILE}}"],
          },
        },
      },
      null,
      2
    ),
    warning:
      "VS Code extension ≤ 2.1.123 does not honour elicitation requests; if write tools fail with NO_USER_RESPONSE, set `EPIMETHIAN_BYPASS_ELICITATION=true`.\n\n" +
      "v6.6.2 declares an `outputSchema` on every write tool, so a spec-compliant client should now surface the soft-confirm `structuredContent` to the agent. If your version of Claude Code drops content blocks when structuredContent is present (issue #15412), set `EPIMETHIAN_TOKEN_IN_TEXT=true` as a fallback — this restores the human-readable explanation by also putting the full token in the text block.",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    configFileHint: ".cursor/mcp.json",
    template: JSON.stringify(
      {
        mcpServers: {
          "epimethian-mcp": {
            command: "{{BIN}}",
            args: ["--profile", "{{PROFILE}}"],
          },
        },
      },
      null,
      2
    ),
  },
  {
    id: "windsurf",
    displayName: "Windsurf",
    configFileHint: "~/.codeium/windsurf/mcp_config.json",
    template: JSON.stringify(
      {
        mcpServers: {
          "epimethian-mcp": {
            command: "{{BIN}}",
            args: ["--profile", "{{PROFILE}}"],
          },
        },
      },
      null,
      2
    ),
  },
  {
    id: "zed",
    displayName: "Zed",
    configFileHint: "~/.config/zed/settings.json (context_servers block)",
    template: JSON.stringify(
      {
        context_servers: {
          "epimethian-mcp": {
            command: {
              path: "{{BIN}}",
              args: ["--profile", "{{PROFILE}}"],
            },
          },
        },
      },
      null,
      2
    ),
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    configFileHint: "opencode.json or ~/.config/opencode/opencode.json",
    template: JSON.stringify(
      {
        mcp: {
          "epimethian-mcp": {
            type: "local",
            command: ["{{BIN}}", "--profile", "{{PROFILE}}"],
            environment: {
              EPIMETHIAN_ALLOW_UNGATED_WRITES: "true",
            },
          },
        },
      },
      null,
      2
    ),
    warning:
      "OpenCode does not yet support MCP elicitation. The `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` env var above removes the interactive confirmation prompt for destructive operations. Read tools and additive writes work without any flag. Upgrade to epimethian-mcp v6.6.0 to get soft elicitation (confirmations routed through the agent), and remove the env var when you do.",
  },
];

export function renderConfigSnippet(
  clientId: string,
  profile: string,
  binPath: string
): { snippet: string; warning?: string } {
  const entry = CLIENT_CONFIGS.find((c) => c.id === clientId);
  if (!entry) {
    const valid = knownClientIds().join(", ");
    throw new Error(
      `Unknown client ID "${clientId}". Valid IDs are: ${valid}`
    );
  }

  const snippet = entry.template
    .replace(/\{\{PROFILE\}\}/g, profile)
    .replace(/\{\{BIN\}\}/g, binPath);

  return { snippet, ...(entry.warning ? { warning: entry.warning } : {}) };
}

export function knownClientIds(): readonly string[] {
  return CLIENT_CONFIGS.map((c) => c.id);
}
