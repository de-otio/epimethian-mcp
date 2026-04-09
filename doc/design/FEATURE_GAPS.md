# Feature Gaps & Potential Additions

Features not available in the official Atlassian Rovo MCP server or popular community servers (sooperset, aashari, etc.).

## High Value — No One Does Well

### 1. Per-Tenant Write Locks

No server offers "read-write for tenant A, read-only for tenant B." Add a `read_only` flag per profile so consultants can protect client tenants from accidental writes while keeping full access to their own.

### 2. Comments (Inline + Footer)

The official server has `getConfluencePageInlineComments`, `getConfluencePageFooterComments`, `createConfluenceFooterComment`, and `createConfluenceInlineComment`. No local MCP server handles inline comments well. This is a big workflow gap for review and collaboration.

### 3. Labels (Get + Add + Remove)

sooperset has get/add but no remove. The official server has nothing. Labels are heavily used for organizing content. The `epimethian-managed` label already shows we're touching this API — expand it into full user-facing tools.

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
