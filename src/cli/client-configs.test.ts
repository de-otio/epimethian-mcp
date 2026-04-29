import { describe, it, expect } from "vitest";
import {
  CLIENT_CONFIGS,
  renderConfigSnippet,
  knownClientIds,
} from "./client-configs.js";

const PROFILE = "globex";
const BIN = "/usr/local/bin/epimethian-mcp";

describe("knownClientIds", () => {
  it("returns the expected seven IDs", () => {
    const ids = knownClientIds();
    expect(ids).toEqual([
      "claude-code",
      "claude-desktop",
      "claude-code-vscode",
      "cursor",
      "windsurf",
      "zed",
      "opencode",
    ]);
  });

  it("returns exactly seven entries", () => {
    expect(knownClientIds().length).toBe(7);
  });
});

describe("renderConfigSnippet", () => {
  it("throws on unknown clientId with list of valid IDs", () => {
    expect(() => renderConfigSnippet("unknown-client", PROFILE, BIN)).toThrow(
      /Unknown client ID "unknown-client"\. Valid IDs are:/
    );
    // The error message should include all known IDs
    try {
      renderConfigSnippet("unknown-client", PROFILE, BIN);
    } catch (e: unknown) {
      const msg = (e as Error).message;
      for (const id of knownClientIds()) {
        expect(msg).toContain(id);
      }
    }
  });

  it("substitutes {{PROFILE}} everywhere it appears", () => {
    for (const id of knownClientIds()) {
      const { snippet } = renderConfigSnippet(id, PROFILE, BIN);
      expect(snippet).not.toContain("{{PROFILE}}");
      expect(snippet).toContain(PROFILE);
    }
  });

  it("substitutes {{BIN}} everywhere it appears", () => {
    for (const id of knownClientIds()) {
      const { snippet } = renderConfigSnippet(id, PROFILE, BIN);
      expect(snippet).not.toContain("{{BIN}}");
      expect(snippet).toContain(BIN);
    }
  });

  it("is deterministic (no timestamps or random IDs)", () => {
    for (const id of knownClientIds()) {
      const first = renderConfigSnippet(id, PROFILE, BIN);
      const second = renderConfigSnippet(id, PROFILE, BIN);
      expect(first).toEqual(second);
    }
  });

  // --- Snapshot tests per client ---

  it("renders claude-code snippet correctly", () => {
    const { snippet, warning } = renderConfigSnippet("claude-code", PROFILE, BIN);
    expect(snippet).toMatchInlineSnapshot(`
      "{
        "mcpServers": {
          "epimethian-mcp": {
            "command": "/usr/local/bin/epimethian-mcp",
            "args": [
              "--profile",
              "globex"
            ]
          }
        }
      }"
    `);
    expect(warning).toBeUndefined();
  });

  it("renders claude-desktop snippet correctly", () => {
    const { snippet, warning } = renderConfigSnippet("claude-desktop", PROFILE, BIN);
    expect(snippet).toMatchInlineSnapshot(`
      "{
        "mcpServers": {
          "epimethian-mcp": {
            "command": "/usr/local/bin/epimethian-mcp",
            "args": [
              "--profile",
              "globex"
            ]
          }
        }
      }"
    `);
    expect(warning).toBeUndefined();
  });

  it("renders claude-code-vscode snippet with warning", () => {
    const { snippet, warning } = renderConfigSnippet("claude-code-vscode", PROFILE, BIN);
    expect(snippet).toMatchInlineSnapshot(`
      "{
        "mcp.servers": {
          "epimethian-mcp": {
            "command": "/usr/local/bin/epimethian-mcp",
            "args": [
              "--profile",
              "globex"
            ]
          }
        }
      }"
    `);
    expect(warning).toBe(
      "VS Code extension ≤ 2.1.123 does not honour elicitation requests; if write tools fail with NO_USER_RESPONSE, set `EPIMETHIAN_BYPASS_ELICITATION=true`."
    );
  });

  it("renders cursor snippet correctly", () => {
    const { snippet, warning } = renderConfigSnippet("cursor", PROFILE, BIN);
    expect(snippet).toMatchInlineSnapshot(`
      "{
        "mcpServers": {
          "epimethian-mcp": {
            "command": "/usr/local/bin/epimethian-mcp",
            "args": [
              "--profile",
              "globex"
            ]
          }
        }
      }"
    `);
    expect(warning).toBeUndefined();
  });

  it("renders windsurf snippet correctly", () => {
    const { snippet, warning } = renderConfigSnippet("windsurf", PROFILE, BIN);
    expect(snippet).toMatchInlineSnapshot(`
      "{
        "mcpServers": {
          "epimethian-mcp": {
            "command": "/usr/local/bin/epimethian-mcp",
            "args": [
              "--profile",
              "globex"
            ]
          }
        }
      }"
    `);
    expect(warning).toBeUndefined();
  });

  it("renders zed snippet correctly", () => {
    const { snippet, warning } = renderConfigSnippet("zed", PROFILE, BIN);
    expect(snippet).toMatchInlineSnapshot(`
      "{
        "context_servers": {
          "epimethian-mcp": {
            "command": {
              "path": "/usr/local/bin/epimethian-mcp",
              "args": [
                "--profile",
                "globex"
              ]
            }
          }
        }
      }"
    `);
    expect(warning).toBeUndefined();
  });

  it("renders opencode snippet with EPIMETHIAN_ALLOW_UNGATED_WRITES env var (v6.5.0 target)", () => {
    const { snippet, warning } = renderConfigSnippet("opencode", PROFILE, BIN);
    expect(snippet).toMatchInlineSnapshot(`
      "{
        "mcp": {
          "epimethian-mcp": {
            "type": "local",
            "command": [
              "/usr/local/bin/epimethian-mcp",
              "--profile",
              "globex"
            ],
            "environment": {
              "EPIMETHIAN_ALLOW_UNGATED_WRITES": "true"
            }
          }
        }
      }"
    `);
    expect(warning).toBe(
      "OpenCode does not yet support MCP elicitation. The `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` env var above removes the interactive confirmation prompt for destructive operations. Read tools and additive writes work without any flag. Upgrade to epimethian-mcp v6.6.0 to get soft elicitation (confirmations routed through the agent), and remove the env var when you do."
    );
  });

  it("opencode snippet uses 'command' array (not 'args') and 'environment' (not 'env')", () => {
    const { snippet } = renderConfigSnippet("opencode", PROFILE, BIN);
    const parsed = JSON.parse(snippet);
    const entry = parsed.mcp["epimethian-mcp"];
    expect(entry.type).toBe("local");
    expect(Array.isArray(entry.command)).toBe(true);
    expect(entry.environment).toBeDefined();
    expect(entry.env).toBeUndefined();
    expect(entry.args).toBeUndefined();
  });
});

describe("CLIENT_CONFIGS entries", () => {
  it("each entry has a non-empty id, displayName, configFileHint, and template", () => {
    for (const entry of CLIENT_CONFIGS) {
      expect(entry.id).toBeTruthy();
      expect(entry.displayName).toBeTruthy();
      expect(entry.configFileHint).toBeTruthy();
      expect(entry.template).toBeTruthy();
    }
  });

  it("all templates are valid JSON", () => {
    for (const entry of CLIENT_CONFIGS) {
      expect(() => JSON.parse(entry.template.replace(/\{\{PROFILE\}\}/g, "x").replace(/\{\{BIN\}\}/g, "y"))).not.toThrow();
    }
  });
});
