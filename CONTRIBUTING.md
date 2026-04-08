# Contributing

Thanks for your interest in contributing to Epimethian MCP.

## Development Setup

```bash
git clone https://github.com/de-otio/epimethian-mcp.git
cd epimethian-mcp
npm install
npm run build
```

## Project Structure

```
src/
  cli/
    index.ts             # Entry point: routes to server or setup
    setup.ts             # Interactive credential setup command
  server/
    index.ts             # MCP server setup + tool registrations
    confluence-client.ts # HTTP helpers, Zod response schemas, formatting
  shared/
    keychain.ts          # OS keychain abstraction (macOS, Linux)
    test-connection.ts   # Connection test for setup command
doc/
  design/                # Design documents
  user-doc/              # End-user documentation
```

## Making Changes

1. Fork the repo and create a branch from `master`
2. Make your changes
3. Run `npm run build` to verify the build passes
4. Run `npm test` to verify all tests pass
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
- Your Node.js version and OS
