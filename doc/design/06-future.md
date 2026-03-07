# Phase 2 Considerations

## Additional Tools
- `add_label` / `remove_label` -- Page label management
- `get_page_comments` / `add_comment` -- Comment operations
- `get_page_history` -- Version history

## Enhancements
- Markdown-to-storage-format conversion
- Cursor-based pagination for large result sets
- In-memory caching for `resolveSpaceId` (space keys rarely change)

## Extension Enhancements
- Status bar item showing connection status
- Auto-test connection on activation (non-blocking)
- "Open in Confluence" command for page IDs in the editor
- Support for multiple Confluence instances (workspace-scoped profiles)

## Cloud Deployment (Future)
If centralized deployment is ever needed (e.g., for Bedrock agents), the server can be adapted to run on AWS AgentCore by:
- Switching transport from stdio to streamable-HTTP on port 8080
- Adding OAuth 2.0 (3LO) for Confluence auth (requires Atlassian org admin)
- Adding IAM SigV4 or Cognito JWT for client auth
- Containerizing for ARM64
