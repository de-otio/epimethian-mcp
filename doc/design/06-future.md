# Phase 2 Considerations

## Additional Tools
- (none remaining — all planned tools have been implemented)

## Enhancements
- Cursor-based pagination for large result sets
- Windows keychain support (Credential Manager via PowerShell)
- Advisory file locking on profile registry (proper-lockfile) for concurrent CLI safety

### Completed in v5.1.0
- ~~Content-safety guards~~ → `confirm_shrinkage`, `confirm_structure_loss`, empty-body rejection on `update_page`
- ~~Additive mutation tools~~ → `prepend_to_page`, `append_to_page`
- ~~Lossless revert~~ → `revert_page` using raw storage from v1 API
- ~~Write-ahead mutation log~~ → opt-in via `EPIMETHIAN_MUTATION_LOG=true`, writes to `~/.epimethian/logs/`
- ~~Pre-write page snapshots~~ → cached before every write for recovery
- ~~Body-length reporting~~ → `body: N→M chars` in all write responses
- ~~User lookup and page link resolution~~ → `lookup_user`, `resolve_page_link`

### Completed in v5.0.0
- ~~Markdown input conversion~~ → `create_page` and `update_page` accept GFM markdown with auto-detection and token-aware preservation

### Completed in v4.5.0
- ~~Content status badges~~ → `get_page_status`, `set_page_status`, `remove_page_status` tools
- ~~Page version history / diff~~ → `get_page_versions`, `get_page_version`, `diff_page_versions` tools. See `investigations/investigate-version-history.md`

### Completed in v4.4.0
- ~~Comment operations~~ → `get_comments`, `create_comment`, `resolve_comment`, `delete_comment` tools. See `investigations/investigate-comments.md`

### Completed in v4.3.0
- ~~Page label management~~ → `get_labels`, `add_label`, `remove_label` tools. See `investigations/investigate-labels.md`

### Completed in v4.2.0
- ~~Per-profile read-only mode~~ → Whitelist-based write guard, strict-mode OR merge, `[READ-ONLY]` tool prefix, default read-only for new profiles. See `investigations/investigate-write-locks.md`

### Completed in v4.1.0
- ~~Token-efficient output mode (headings_only, section, max_length, format: markdown)~~ → See `investigations/investigate-token-efficiency.md`
- ~~In-memory page cache (version-keyed, LRU eviction)~~ → See `page-cache.ts`
- ~~Search excerpts~~ → Switched to `/rest/api/search` endpoint
- ~~Section-level editing (update_page_section)~~ → New tool
- ~~Markdown write guard on update_page~~ → Rejects markdown input

## CLI Enhancements
- `epimethian-mcp update` -- Self-update to latest npm version

### Completed in v3.0.0
- ~~`epimethian-mcp status` -- Show current connection info and credential status~~ → See `10-multi-tenant.md`
- ~~Support for multiple Confluence instances (named profiles in keychain)~~ → See `10-multi-tenant.md`

## Cloud Deployment (Future)
If centralized deployment is ever needed (e.g., for Bedrock agents), the server can be adapted to run on AWS AgentCore by:
- Switching transport from stdio to streamable-HTTP on port 8080
- Adding OAuth 2.0 (3LO) for Confluence auth (requires Atlassian org admin)
- Adding IAM SigV4 or Cognito JWT for client auth
- Containerizing for ARM64
