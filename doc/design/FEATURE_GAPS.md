# Feature Gaps & Potential Additions

Features not available in the official Atlassian Rovo MCP server or popular community servers (sooperset, aashari, etc.).

## High Value — No One Does Well

### 1. ~~Per-Tenant Write Locks~~ ✅ Implemented in v4.2.0

Per-profile `readOnly` flag in profile settings with whitelist-based write guard, strict-mode OR merge (env var can only tighten), `[READ-ONLY]` tool description prefix, and default read-only for new profiles. See `investigations/investigate-write-locks.md`.

### 2. ~~Comments (Inline + Footer)~~ ✅ Implemented in v4.4.0

`get_comments`, `create_comment`, `resolve_comment`, and `delete_comment` tools. The official server has read-only comment access; epimethian adds full comment lifecycle management including resolve/reopen and deletion. See `investigations/investigate-comments.md`.

### 3. ~~Labels (Get + Add + Remove)~~ ✅ Implemented in v4.3.0

`get_labels`, `add_label`, and `remove_label` tools. sooperset has get/add but no remove. The official server has nothing. Labels are heavily used for organizing content.

### 4. Page Version History / Diff

No MCP server exposes version history or diffs between versions. Useful for AI-assisted content review ("what changed since last week?"). Confluence API: `/wiki/rest/api/content/{id}/version`.

## Medium Value — Ecosystem Gaps

### 5. Content Format Flexibility

sooperset supports markdown, wiki markup, and storage format for input. Epimethian uses storage format only. Supporting markdown input (converting to storage format) would lower the barrier for AI agents that think in markdown.

### 6. Page Templates

No server supports creating pages from Confluence templates. The API supports it: `/wiki/rest/api/template`.

### 7. Permissions / Restrictions Viewer

Know who can see/edit a page before writing to it. No MCP server exposes this, but the API supports it: `/wiki/rest/api/content/{id}/restriction`.

### 8. Bulk Operations

Move pages, copy page trees, bulk label application. Useful for reorganization tasks consultants frequently do.

## Lower Priority But Differentiating

### 9. ~~Token-Efficient Output Mode~~ ✅ Implemented in v4.1.0

Content windowing (`headings_only`, `section`, `max_length`), read-only markdown rendering (`format: "markdown"`), in-memory page cache, search excerpts, section-level editing (`update_page_section`), and markdown write guard. See `investigations/investigate-token-efficiency.md`.

### 10. Page Tree Visualization

Return a hierarchical tree of a space's page structure. Useful for understanding how content is organized before making changes.

### 11. Webhook / Watch Management

Subscribe to page changes. Not available in any MCP server.

## Priority Order

Given the multi-tenant consultant focus:

1. Per-profile read-only mode — highest safety impact, unique differentiator
2. Comments support — big workflow gap, official server has it but local servers don't
3. Labels management — low effort, high utility, already touching the API
4. Page version history — unique feature no one else offers
5. Markdown input support — quality-of-life for AI agents
