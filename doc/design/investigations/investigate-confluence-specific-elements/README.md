# Investigation: Confluence-specific Elements (Panels, Macros, Page Links, Status, ToC, Expand)

**STATUS: 🔍 PROPOSED** — informs the markdown→storage converter being added alongside the bug fix in `toStorageFormat()` (see [Bug background](#bug-background)).

## Contents

1. [Data preservation guarantee](01-data-preservation.md) — the mandatory invariant that everything else hangs off
2. [Elements and use cases](02-elements-and-use-cases.md) — what we need to support and why
3. [Storage format reference](03-storage-format-reference.md) — the XML targets the converter must emit
4. [Markdown syntax design](04-markdown-syntax-design.md) — how callers express each element
5. [Implementation plan](05-implementation-plan.md) — four phases
6. [Security](06-security.md) — consolidated threat analysis and mitigations
7. [Design decisions and open questions](07-design-decisions.md) — defaults, rationale, items needing review
8. [Alternatives considered](08-alternatives-considered.md) — paths rejected and why
9. [Acceptance criteria](09-acceptance-criteria.md) — measurable definition of done
10. [Out of scope](10-out-of-scope.md) — explicit non-goals
11. [Implementation checklist (parallel multi-agent)](11-implementation-checklist.md) — streams, dependencies, model assignments, coverage strategy

## Problem

`create_page` and `update_page` accept a `body` parameter advertised as *"plain text or Confluence storage format (HTML)"*. In practice, callers (humans **and** AI agents) overwhelmingly write markdown — it is the lingua franca of LLM-generated content, README files, and the existing data emitted by sibling MCP servers (e.g. `entrix-network`'s `generate_confluence_page` returns markdown).

The current `toStorageFormat()` ([confluence-client.ts:1031-1033](../../../../src/server/confluence-client.ts#L1031-L1033)) is a one-line shim that wraps tagless input in `<p>...</p>`. It is not a markdown converter. This produces broken pages (single-paragraph blobs containing literal `#`, `|`, `-`) and silently corrupts the Confluence space.

A markdown→storage converter solves the basic case (headings, lists, tables, code blocks, links). But **the substantive value of Confluence over plain HTML is its rich macro ecosystem** — info/warning panels for callouts, status badges for workflow signalling, ToC for long pages, expand for progressive disclosure, and `<ac:link>` for stable cross-page references. Without first-class support for these, agents writing pages via the MCP will produce content that is *technically rendered* but visually and semantically inferior to what humans produce in the editor.

This investigation enumerates the Confluence-specific elements that matter, evaluates how to expose them through markdown so the converter can emit native macros, and recommends an implementation path.

## Bug background

Discovered while creating an EX-3946 documentation tree from an external project. `update_page` correctly rejects markdown via [`looksLikeMarkdown()`](../../../../src/server/index.ts#L378), but `create_page` has no such guard — markdown silently produces broken pages. The fix is to add a real converter (and apply it symmetrically), not just to add a guard. This investigation defines what that converter should support beyond plain GFM.

## Headline constraint

> **A page update must never unintentionally remove content from an existing page.**

This is non-negotiable. It promotes lossless round-trip from a Phase 3 "nice to have" (as originally drafted) to a Phase 1 mandatory pre-condition for any markdown-input write path. See [01-data-preservation.md](01-data-preservation.md) for the full mechanism.
