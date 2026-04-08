# Implementation Checklist

> **Note:** This checklist reflects the v2.0.0 conversion from VS Code extension to standalone npm package. All items are complete.

---

## Phase 1: Extract Shared Code and Refactor Server

- [x] Extract `testConnection()` from `src/extension/config.ts` to `src/shared/test-connection.ts`
- [x] Update `src/server/confluence-client.ts` error message to reference `epimethian-mcp setup`
- [x] Export `main()` from `src/server/index.ts` (remove auto-execution)

## Phase 2: Create CLI Entry Point and Setup Command

- [x] Create `src/cli/index.ts` -- dual-mode entry point with shebang
- [x] Create `src/cli/setup.ts` -- interactive credential setup with masked input

## Phase 3: Build System Changes

- [x] Update `esbuild.config.mjs` -- single entry point, shebang banner, remove vscode external

## Phase 4: Package Configuration

- [x] Update `package.json` -- `@de-otio/epimethian-mcp`, bin, files, publishConfig
- [x] Update `tsconfig.json` -- include `src/cli` instead of `src/extension`
- [x] Update `vitest.config.ts` -- replace extension threshold with CLI threshold

## Phase 5: Delete Extension Files

- [x] Delete `src/extension/` (all 8 files)
- [x] Delete `src/shared/types.ts`
- [x] Delete `.vscodeignore`
- [x] Delete `.vsix` artifacts

## Phase 6: Tests

- [x] Create `src/shared/test-connection.test.ts`
- [x] Create `src/cli/index.test.ts`
- [x] Create `src/cli/setup.test.ts`
- [x] Update `src/server/index.test.ts` to call exported `main()`
- [x] Fix `confluence-client.test.ts` assertions for attribution footer

## Phase 7: CI/CD

- [x] Update `.github/workflows/build.yml` -- simplified CI
- [x] Create `.github/workflows/publish.yml` -- OIDC npm publishing

## Phase 8: Documentation

- [x] Create `install-agent.md`
- [x] Rewrite `README.md`
- [x] Update design docs (`doc/design/`)

## Verification

- [x] `npm run build` produces `dist/cli/index.js` with shebang
- [x] `npm test` -- 74 tests pass across 5 test files
- [x] `npm pack --dry-run` -- only `dist/` + metadata (375 KB)
