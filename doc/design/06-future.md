# Phase 2 Considerations

## Additional Tools
- `add_label` / `remove_label` -- Page label management
- `get_page_comments` / `add_comment` -- Comment operations
- `get_page_history` -- Version history

## Enhancements
- Cursor-based pagination for large result sets
- Windows keychain support (Credential Manager via PowerShell)

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
