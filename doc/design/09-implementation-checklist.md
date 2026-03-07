# Implementation Checklist

This checklist is organized into parallel workstreams. Tasks within a workstream are sequential; workstreams themselves can run concurrently. Dependencies between workstreams are noted inline.

Target: 80% test coverage across the project.

---

## Workstream A: Project Scaffolding & Build

Restructures the repo from the POC layout to the extension layout. All other workstreams depend on A1-A3.

- [ ] **A1.** Restructure `src/` directories
  - Move `src/index.ts` to `src/server/index.ts`
  - Move `src/confluence-client.ts` to `src/server/confluence-client.ts`
  - Create `src/extension/` (empty, populated by Workstream B)
  - Create `src/shared/` (empty, populated by Workstream C)
  - Update import paths in `src/server/index.ts`
  - Verify `npm run build` still works with the old tsc setup

- [ ] **A2.** Convert `package.json` to VS Code extension manifest
  - Add `publisher`, `displayName`, `description`, `categories`, `icon`
  - Add `engines.vscode` (e.g., `"^1.96.0"`)
  - Remove top-level `"type": "module"` (esbuild bundles to CJS)
  - Add `contributes.commands` (`epimethian-mcp.configure`, `epimethian-mcp.testConnection`)
  - Add `contributes.mcpServers` block per [07-vscode-extension.md](07-vscode-extension.md)
  - Add `contributes.configuration` for `epimethian-mcp.url` and `epimethian-mcp.email` settings
  - Add `activationEvents: ["onStartupFinished"]`
  - Set `"main": "dist/extension.js"`
  - Add dev dependencies: `esbuild`, `@vscode/vsce`, `@types/vscode`
  - Add scripts: `build` (esbuild), `package` (`vsce package`), `watch`
  - Run `npm install` to regenerate lock file

- [ ] **A3.** Create `esbuild.config.mjs`
  - Two entry points: `src/extension/extension.ts` -> `dist/extension.js`, `src/server/index.ts` -> `dist/server.js`
  - CJS format, node platform, sourcemaps enabled
  - External: `vscode` (extension bundle only)
  - Verify both bundles produce valid output

- [ ] **A4.** Create `.vscodeignore`
  - Exclude `src/`, `node_modules/`, `doc/`, `prompts/`, `*.md`, `tsconfig.json`, `esbuild.config.mjs`, test files
  - Include `dist/`, `media/`, `package.json`, `LICENSE`

- [ ] **A5.** Update `tsconfig.json`
  - Keep strict mode
  - Adjust for CJS output (esbuild handles bundling; tsc used only for type-checking)
  - Add `"noEmit": true` (esbuild does the emit)
  - Ensure `include` covers `src/extension`, `src/server`, `src/shared`

- [ ] **A6.** Remove POC artifacts
  - Delete `src/index.ts` and `src/confluence-client.ts` (after A1 moves them)
  - Remove `"dev"` and `"start"` scripts from `package.json` (no longer applicable)

---

## Workstream B: Extension Host

Implements the VS Code extension activation, command registration, and MCP environment provider. Depends on A1-A3.

- [ ] **B1.** Create `src/extension/extension.ts`
  - `activate()`: register configure command, register MCP environment provider
  - `deactivate()`: no-op (cleanup handled by VS Code)
  - MCP environment provider reads URL/email from settings, token from SecretStorage
  - Per [07-vscode-extension.md](07-vscode-extension.md) activation code

- [ ] **B2.** Create `src/extension/config.ts`
  - `saveCredentials(context, url, email, apiToken)` — writes settings + SecretStorage
  - `loadCredentials(context)` — reads settings + SecretStorage
  - `testConnection(url, email, apiToken)` — GET `/wiki/api/v2/spaces?limit=1`, returns `{ ok, message }`

- [ ] **B3.** Create `src/extension/webview.ts`
  - `ConfigPanel` class implementing `WebviewViewProvider` or managing a `WebviewPanel`
  - `createOrShow(context)` static method
  - Handle incoming messages: `save`, `testConnection`, `requestConfig`
  - Send outgoing messages: `configLoaded`, `testResult`, `saved`
  - Set Content Security Policy restricting scripts to extension resources
  - Persist "last verified" timestamp in `context.globalState`

---

## Workstream C: Shared Types & Webview UI

No dependency on B; only depends on A1-A3.

- [ ] **C1.** Create `src/shared/types.ts`
  - `WebviewMessage` union type (save, testConnection, requestConfig)
  - `ExtensionMessage` union type (configLoaded, testResult, saved)
  - Per [07-vscode-extension.md](07-vscode-extension.md) message protocol

- [ ] **C2.** Create `media/webview.html`
  - Form fields: Confluence URL, email, API token (password input)
  - Link to Atlassian token generation page
  - Test Connection button, Save button
  - Status area (last verified timestamp, connection status)
  - CSP meta tag with nonce placeholder

- [ ] **C3.** Create `media/webview.css`
  - Use VS Code CSS variables (`--vscode-input-background`, etc.) for native look
  - Responsive single-column layout

- [ ] **C4.** Create `media/webview.js`
  - Acquire `vscode` API via `acquireVsCodeApi()`
  - Post `requestConfig` on load
  - Handle form submit -> post `save` message
  - Handle test button -> post `testConnection` message
  - Listen for `configLoaded`, `testResult`, `saved` messages and update UI

---

## Workstream D: Server Tests

Tests for the MCP server and Confluence client. Can begin as soon as A1 is done (files moved to `src/server/`).

- [ ] **D1.** Set up test infrastructure
  - Add `vitest` as dev dependency (works with both ESM and CJS, fast)
  - Add `vitest.config.ts` with coverage provider (`v8` or `istanbul`)
  - Add `test` and `test:coverage` scripts to `package.json`
  - Configure coverage thresholds: 80% lines, 80% branches, 80% functions

- [ ] **D2.** Test `confluence-client.ts` — HTTP helpers
  - Mock `global.fetch` for all tests
  - `confluenceRequest()`: test success, 4xx, 5xx responses
  - `v2Get()`: test URL construction with params
  - `v2Post()`, `v2Put()`: test payload serialization
  - `v2Delete()`: test void return on success

- [ ] **D3.** Test `confluence-client.ts` — Zod schema validation
  - `PageSchema`: valid page, missing optional fields, invalid data
  - `SpacesResultSchema`: valid spaces list, empty results
  - `AttachmentSchema`: valid attachment, missing extensions
  - `UploadResultSchema`: valid upload response, empty results array

- [ ] **D4.** Test `confluence-client.ts` — public API functions
  - `resolveSpaceId()`: success, space not found
  - `getPage()`: with and without body
  - `createPage()`: payload construction, parentId optional
  - `updatePage()`: version auto-increment, partial updates (title only, body only)
  - `deletePage()`: success
  - `searchPages()`: results, empty results
  - `listPages()`: with status and limit params
  - `getPageChildren()`: results, empty
  - `getSpaces()`: with and without type filter
  - `getPageByTitle()`: found, not found
  - `getAttachments()`: results, empty
  - `uploadAttachment()`: FormData construction, comment optional, empty results error

- [ ] **D5.** Test `confluence-client.ts` — formatting helpers
  - `toStorageFormat()`: plain text wrapping, HTML passthrough
  - `formatPage()`: with body, without body, missing optional fields (_links, version, space)

- [ ] **D6.** Test `src/server/index.ts` — tool registration smoke tests
  - Verify all 12 tools are registered on the MCP server
  - Test `toolResult()` and `toolError()` helper output shapes
  - Test `add_attachment` file path security check (path outside cwd rejected)
  - Test `add_drawio_diagram` filename normalization (.drawio appended when missing)

---

## Workstream E: Extension Tests

Tests for the extension host code. Depends on B1-B3.

- [ ] **E1.** Test `config.ts`
  - Mock `vscode.workspace.getConfiguration` and `context.secrets`
  - `saveCredentials()`: verify settings updated, token stored in SecretStorage
  - `loadCredentials()`: verify reads from settings and SecretStorage
  - `testConnection()`: mock fetch, test success (parse display name), 401 error, network error

- [ ] **E2.** Test `extension.ts`
  - Mock `vscode.commands.registerCommand`, `vscode.lm.registerMCPServerEnvironmentProvider`
  - `activate()`: verify configure command registered, MCP env provider registered
  - MCP env provider `resolveEnvironment()`: verify it injects URL, email, token into env

- [ ] **E3.** Test `webview.ts`
  - Mock `vscode.window.createWebviewPanel`
  - Test `createOrShow()` creates panel on first call, reveals on second
  - Test message handling: `requestConfig` triggers `configLoaded` reply
  - Test message handling: `save` triggers `saveCredentials` + `saved` reply
  - Test message handling: `testConnection` triggers `testConnection` + `testResult` reply
  - Verify CSP is set on the webview HTML

---

## Workstream F: CI & Packaging

Can run in parallel with all other workstreams. Only needs the final build to work end-to-end.

- [ ] **F1.** Create `.github/workflows/build.yml`
  - Per [08-ci.md](08-ci.md) workflow definition
  - Steps: checkout, setup-node, npm ci, build, test with coverage, vsce package, upload artifact
  - Add test step between build and package: `npm test -- --coverage`
  - Fail the build if coverage drops below 80%

- [ ] **F2.** Add optional tagged-release job
  - Triggered on `refs/tags/v*`
  - Attach `.vsix` to GitHub Release via `softprops/action-gh-release@v2`

- [ ] **F3.** Verify end-to-end
  - Run `npm run build` (esbuild)
  - Run `npm test -- --coverage` (80% threshold)
  - Run `npx @vscode/vsce package --no-dependencies`
  - Install resulting `.vsix` in VS Code and verify activation

---

## Dependency Graph

```
A1 ─> A2 ─> A3 ─> A5 ─> A6
       │     │
       │     ├──> B1 ─> B2 ─> B3 ──> E1 ─> E2 ─> E3
       │     │
       │     ├──> C1 (parallel with B)
       │     ├──> C2 ─> C3 ─> C4
       │     │
       │     └──> D1 ─> D2 ─> D3 ─> D4 ─> D5 ─> D6
       │
       └──> A4
                              F1, F2 (parallel, need final build)
                              F3 (after everything)
```

## Parallel Agent Assignment

| Agent | Workstreams | Rationale |
|-------|-------------|-----------|
| Agent 1 | A (all), then F | Scaffolding owner; knows the build system; finishes with CI |
| Agent 2 | B, then E | Extension host implementation and its tests |
| Agent 3 | C, then D | Webview UI + server tests (server code is read-only for this agent) |

Agent 1 must complete A1-A3 before Agents 2 and 3 can start. After that, all three agents work independently until F3 (final integration verification).
