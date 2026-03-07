# Contributing

Thanks for your interest in contributing to epimethian-mcp.

## Development Setup

```bash
git clone https://github.com/rmyers/epimethian-mcp.git
cd epimethian-mcp
npm install
npm run build
```

## Project Structure

```
src/
  extension/
    extension.ts         # VS Code extension activate / deactivate
    config.ts            # SecretStorage + settings helpers
    webview.ts           # Configuration webview panel
    mcp-clients.ts       # Multi-client MCP config registration
  server/
    index.ts             # MCP server setup + tool registrations
    confluence-client.ts # HTTP helpers, Zod response schemas, formatting
  shared/
    types.ts             # Message types shared between extension & webview
doc/
  design/                # Design documents
  user-doc/              # End-user documentation
prompts/                 # Prompt history
```

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run build` to verify the build passes
4. Run `npm test` if tests exist for the area you changed
5. Open a pull request

## Guidelines

- Keep PRs focused on a single change
- Follow the existing code style
- Add tests for new tools or significant logic changes
- Update `doc/user-doc/tools-reference.md` if you add or modify tools

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your VS Code version and OS
