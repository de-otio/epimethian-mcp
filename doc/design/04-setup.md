# Setup

## For Users

### Via AI Agent (Recommended)

Tell your AI agent:

> Install and configure the Epimethian MCP server. See https://github.com/de-otio/epimethian-mcp

The agent will read `install-agent.md` from the repository and handle the installation and configuration.

### Manual Installation

```bash
npm install -g @de-otio/epimethian-mcp
epimethian-mcp setup --profile <name>
```

The `setup --profile` command prompts for:
1. Confluence URL (e.g., `https://yoursite.atlassian.net`)
2. Email address
3. API token (masked input)

It tests the connection and stores all three credentials in the OS keychain under the named profile.

### Registry preflight and lock

The profile registry (`~/.config/epimethian-mcp/profiles.json`) holds each profile's non-secret settings, including the restrictions that limit what the agent may do. Every CLI command that changes it follows the same rules:

- **Preflight.** `setup` (site and gateway modes) and `profiles --remove` read the registry before any keychain write or delete. If it is unreadable (a JSON syntax error, an unexpected top-level shape, a file or directory that is group- or world-writable or owned by another user, or a symlink), the command prints what is wrong and the fix, without a stack trace, and exits 1. Neither the keychain nor the file is touched, so a broken registry cannot leave credentials stored for a profile the registry does not know. An absent registry is not an error: the first write creates it with mode 0600.
- **Never overwritten.** No writer replaces an unreadable file, and no temp file is created before that check. The file is fixed by hand, not by the CLI.
- **Lock.** Writers take `profiles.json.lock` (created exclusively, mode 0600, holding the pid and time), retrying every 50 ms for up to 5 s, so two commands cannot overwrite each other. A lock older than 60 s whose process is gone is removed with a warning. Otherwise the command refuses with "Another epimethian-mcp command is changing the profile registry. Try again in a moment; nothing was changed." and exits 1.
- **Write.** The new version goes to a temp file in the same directory (exclusive, no symlink following, mode 0600), is flushed to disk and renamed over the registry; a hand edit made during the write is detected and the change re-applied to the edited file. Temp files left by a crash are removed after an hour.
- **Backup.** When the registry was readable, `profiles.json.bak` holds its bytes from before the write: the version before the last CLI change. It is not a history, and an absent registry leaves an existing `.bak` untouched.
- **Unknown keys.** Top-level keys the CLI does not know are written back unchanged.

At server start the registry is read once. If it is unreadable, the server starts in recovery mode: its only tool, `setup_profile`, returns a `Withheld [REGISTRY_UNREADABLE]` message with the problem and the fix, and the agent relays it without editing the file. The fix for a group- or world-writable registry is `chmod 600 ~/.config/epimethian-mcp/profiles.json`; a symlinked registry must be replaced with a regular file. Restart the MCP client afterwards.

Then add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "epimethian-mcp",
      "env": {
        "CONFLUENCE_PROFILE": "<profile-name>"
      }
    }
  }
}
```

## Generate an API Token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click **Create API token**
3. Give it a label (e.g., "Epimethian MCP") and click **Create**
4. Copy the token (shown only once)
5. Paste it into the `epimethian-mcp setup --profile <name>` prompt

No admin access required. Any Confluence user can generate their own token.

## How Credentials Are Stored

| Setting | Storage | Location |
|---------|---------|----------|
| Profile name | MCP config (`.mcp.json`) | `CONFLUENCE_PROFILE` env var, not secret |
| Confluence URL | OS keychain | Stored per-profile, never in config files |
| Email | OS keychain | Stored per-profile, never in config files |
| API token | OS keychain | Stored per-profile, never in config files |

All credentials are stored as an atomic unit per profile. The API token never appears in plaintext config files. Credentials are encrypted at rest by the OS credential store.

For CI/CD environments without a keychain, all three env vars (`CONFLUENCE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN`) can be set directly. Partial combinations are rejected.

## For Developers (Building from Source)

```bash
git clone https://github.com/de-otio/epimethian-mcp.git
cd epimethian-mcp
npm install
npm run build
npm test
```
