# Investigation: Findings from a long editing session (2026-10)

**STATUS: PROPOSED** (nothing implemented). Written 2026-10-06 against `master` at
f03ee8a (6.10.1). The session itself ran 6.10.0.

## Context

One Claude Code session used epimethian for about 25 writes and 30 reads on a tree of
about a dozen pages in the new editor: section edits (mostly
`find_replace`), a few full-page updates, draw.io diagrams, CQL searches and version
diffs. Alongside it, a sweep of the current code and a check of what changed in the MCP
specification (now 2026-07-28) and in the Confluence Cloud REST API since this server was
designed. Sources are at the end. Items marked *(unverified)* rest on one secondary
source and need checking before work starts.

Related: [investigate-token-efficiency.md](investigate-token-efficiency.md),
[investigate-bulk-operations.md](investigate-bulk-operations.md) (`move_page` design;
its rate-limit section needs the correction in A5).

## Summary

| ID | Finding | Area | Effort | Phase |
|---|---|---|---|---|
| S1 | `find_replace` skips the deletion gate and the canary check, and replaces every match | Safety | S | 1 |
| S2 | Section, markdown and truncated reads return the body unfenced | Safety | S | 1 |
| S3 | Claude Code truncates tool descriptions at 2,048 chars; safety text is cut | Safety, tokens | S | 1 |
| S4 | An elicitation "confirm" can be auto-answered by a client hook | Safety | S | 1 |
| S5 | `search_pages` pulls other spaces' titles and excerpts into context | Safety, tokens | M | 2 |
| S6 | `diff_page_versions` reports "No changes." when only macro content changed | Safety | M | 2 |
| S7 | Approval-required spaces will reject page PUTs with 409 | Robustness | S | 2 |
| R1 | No timeout, no retry, no 429 handling in `confluenceRequest` | Speed | S | 2 |
| R2 | Every write makes two extra calls (label, badge) | Speed | S | 2 |
| R3 | `update_page_sections` lacks `find_replace` (README claims it has it) | Speed, tokens | M | 2 |
| R4 | A cache hit still makes a metadata GET | Speed | S | 4 |
| R5 | Read-only tools without `readOnlyHint` cannot run in parallel | Speed | S | 1 |
| T1 | `local-id` attributes inflate storage reads | Tokens | M | 3 |
| T2 | No find-in-page | Tokens | M | 3 |
| T3 | No structural edits (insert section, rename heading, anchor insert) | Tokens, safety | M | 3 |
| T4 | `find` must match entity encoding byte for byte | Tokens | M | 3 |
| T5 | One fence per field, each with a canary | Tokens | S | 3 |
| T6 | Tool list size and order | Tokens | S | 3 |
| A1 | v1 content endpoints in use are gone from Atlassian's published v1 spec | Currency | M | 4 |
| A2 | Move page, delete attachment, new attachment version | Features | M | 4 |
| A3 | MCP annotations, validation errors, SDK floor, 2026-07-28 | Currency | S–M | 4 |
| A4 | Scoped API tokens and token expiry *(unverified)* | Currency | S | 4 |
| A5 | Rate-limit facts in the bulk-operations investigation are out of date | Docs | S | 1 |

## Safety

### S1. `find_replace` is the least-guarded write path

**Observed.** `find_replace` was the cheapest way to edit and was used for most writes in
the session. One call failed because the find string crossed an `<ac:link>`; the error
message was clear.

**Code.**
- `index.ts:2011-2022` treats `find_replace` as "non-destructive (no deletion gate)" and
  goes straight to `safeSubmitPage`. It never passes through `safePrepareBody`, so the
  canary echo check and `enforceContentSafetyGuards` do not run.
- `safe-write.ts:1932-1944` applies `working.split(find).join(replace)`: **every**
  occurrence is replaced, not one.
- Macros become `[[epi:Tnnnn]]` placeholders before the substitution and are restored
  from the sidecar afterwards. A placeholder that the replacement drops is never
  restored, so the macro is **deleted without any gate**. A placeholder that the
  replacement repeats **duplicates** the macro.

**Proposal.**
1. Each `find` must match exactly once. `replace_all: true` opts in to several; the error
   reports the count.
2. Compare the placeholder multiset before and after. Lost placeholders go through the
   existing `confirm_deletions` gate with a forecast. Duplicated placeholders are an error
   unless explicitly allowed.
3. Run the canary/fence echo check and the content-safety guards on the resulting page.
4. Correct the comment at `index.ts:2011`.

**Tests.** A find that matches twice is rejected. A replacement that drops
`[[epi:T0001]]` hits the deletion gate. A replacement that contains the session canary is
rejected. A replacement that moves a placeholder keeps the macro exactly once.

### S2. Cheap reads are the unfenced ones

**Code.** `index.ts:1020-1056`: `get_page` with `section` (storage or markdown), with
`format: "markdown"`, or with a body over `max_length` returns
`toolResult(header + content)` without the untrusted-content fence. Only the full,
untruncated storage path goes through `formatPage`, which fences.

**Observed.** A `section` read in the session returned the body without a fence.

**Why it matters.** Tool descriptions and the README steer agents to exactly these paths
(drill-down), so the most-used reads carry no injection boundary.

**Proposal.** One helper for every body-returning path. **Test:** iterate every
combination of `section`, `format`, `max_length`, `headings_only` on `get_page`,
`get_page_by_title` and `get_page_version`, and assert fence plus canary on each.

### S3. Tool descriptions are truncated by Claude Code

Claude Code's tool search truncates each tool description, and the server instructions,
at 2,048 characters. `update_page` is about 2,790 characters; in the session its
description ended "If your MCP client does not sup… [truncated]". Four more tools are
between 1,245 and 1,740 and close to the limit.

**Proposal.** A CI check that fails above 1,800 characters per description. Put the
safety rules first. Move worked examples to `install-agent.md` or a docs resource.
**Open:** whether Claude Code also truncates parameter descriptions.

### S4. Elicitation is not a guaranteed human gate

In Claude Code an `Elicitation` hook can answer an elicitation automatically, so a
"confirm" may never reach a person. Claude Code honours
`_meta["anthropic/requiresUserInteraction"]: true`, which forces an approval prompt on
every call of that tool.

**Proposal.** Set it on the tools that are always destructive: `delete_page`,
`revert_page`, `delete_comment`, `authorise_destructive_writes`, and `delete_attachment`
when it exists (A2). Keep soft confirmation tokens for flag-gated writes, where a static
per-tool prompt would be too broad.

### S5. Search pulls other spaces into context

**Observed.** A CQL search over `space.type = "global"` returned titles and excerpts from
unrelated spaces, including names of third parties and staff. For a consultant working
under confidentiality rules, that content is now in the agent's context and can leak into
files it writes.

**Code.** `index.ts:2695-2737` takes raw `cql` and `limit`. The profile `spaces`
allowlist applies to writes only (`space-allowlist.ts`). `@@@hl@@@` highlight markers
pass through.

**Proposal.**
1. An optional profile setting for read scope. When set, `search_pages` adds
   `space in (...)` unless the call passes `all_spaces: true`.
2. An `excerpts: false` parameter. The default stays on (Decision 4 of the
   token-efficiency investigation).
3. Strip the highlight markers.
4. An optional profile list of patterns redacted in **search results and titles only**.
   Redacting page bodies would break `find_replace` round trips.

### S6. The diff hides macro-internal changes

**Code.** `diff_page_versions` renders both versions through `toMarkdownView`
(`confluence-client.ts:2309-2385`), which turns each macro into `[macro: name]` and drops
attributes and link targets. If the text is identical, `diff.ts:111` reports
"No changes."

**Observed.** Two consecutive versions edited by a person diffed as "No changes." An
agent asked to proofread the owner's edits would miss any edit inside a panel or expand,
because those bodies are invisible to the diff.

**Proposal.**
1. Always compare normalised storage (attributes such as `local-id` removed) as well. If
   the text diff is empty but storage differs, report "No text changes; N
   macro/attribute changes" and name the macros.
2. Add `format: "storage"` for a raw unified diff of the normalised storage.
3. Render rich-text bodies of panels and expands as text in the markdown view instead of
   collapsing them.

### S7. Approval-required spaces

Atlassian has announced that direct page PUTs in spaces that require publishing approval
will return 409 (date not yet set). Map that response to a clear, non-retried error that
names the cause.

## Speed and reliability

### R1. Timeouts, retries and 429s

**Code.** `confluenceRequest` (`confluence-client.ts:840-861`) calls `fetch` with no
timeout, no retry and no `Retry-After` handling. The bulk-operations investigation
already marks retry as "Required".

**Correction to that investigation (A5).** Atlassian's points-based limits (enforced since
2 March 2026) apply to Forge, Connect and OAuth 3LO apps. API-token traffic, which is how
this server authenticates, stays on the existing burst limits, so 429s remain possible
during batches.

**Proposal.**
1. A timeout on every request, for example 30 s for reads and 60 s for writes.
2. Retry GET only, on 429 or 503, only when `Retry-After` is present: at most three
   attempts, with jitter. Never retry PUT or POST automatically.
3. A process-wide concurrency cap, also covering the unbounded comment-reply fan-out
   (`index.ts:3656`).

### R2. Two extra calls per write

Every write is followed by `ensureAttributionLabel` and `markPageUnverified`
(`index.ts:2047-2050` on the `find_replace` path; the same on the others). One page in the
session took four section writes: at least 12 requests and four versions.
**Proposal:** remember per page and process that the label and badge are set, and skip
the calls when nothing could have removed them since.

### R3. `find_replace` in `update_page_sections`

`update_page_sections` accepts only `{section, body}` (`index.ts:2300-2322`), although
README.md:220 says it also takes `find_replace`. Accepting it per entry gives one PUT and
one version for a multi-section edit, without resending section bodies. Either implement
it or correct the README now.

### R4. Cache hits still fetch metadata

The version-keyed page cache still makes a metadata GET on every hit
(`confluence-client.ts:920-931`). Right after the server's own write it already knows the
version. A short freshness window is safe because writes carry the version number: a
stale read leads to a 409 on write, not to lost data. Low priority.

### R5. Missing `readOnlyHint`

`lookup_user`, `resolve_page_link` and `get_version` have no annotations. Claude Code
uses `readOnlyHint` to decide whether tool calls may run in parallel. (`upgrade` is not
read-only and should say so.)

## Token efficiency

### T1. Compact storage reads

New-editor pages carry `local-id` / `ac:local-id` on most elements and `ac:macro-id` on
macros. On one 8.8 KB page in the session they were roughly a third of the body (an
estimate). Rows inserted without `local-id` were accepted, and Confluence filled the
attributes in itself. A community report says macro local IDs regenerate on every version
anyway *(unverified)*.

**Proposal.** A `compact: true` read that strips these attributes, with `find_replace`
matching against the same normalised form through an offset map back to the stored body.
Substituted ranges lose their `local-id`, which Confluence regenerates.

### T2. Find in page

To read one table row of a 97,000-character page, the options were a 50,000-character
head truncation or a truncated markdown view. **Proposal:** `get_page` with
`grep: "<literal>"`, returning each matching block element (paragraph, list item, table
row) with its heading path and storage, fenced. Lossless and usable for a following
`find_replace`.

### T3. Structural edits

**Observed in the session:**
- Adding a section meant smuggling a new `<h2>` into the previous section's
  `find_replace`.
- Renaming a heading needed a full `update_page`.
- One `find_replace` failed because the find string crossed an `<ac:link>`.

**Proposal:**
- `insert_section` with `after_heading` or `before_heading`, a level, a heading and a body;
- `rename_heading`;
- `insert_before` / `insert_after` an anchor string that must match exactly once.

Document that find strings may contain `[[epi:Tnnnn]]` placeholders, and number them the
same way everywhere. Today the markdown section view numbers them from the heading
(`index.ts:210-237`), while `find_replace` numbers them from the body: an off-by-one when
the heading itself contains a macro.

### T4. Entity- and Unicode-tolerant matching

Matching is byte-exact (`safe-write.ts:1932`), so `ü` does not match `&uuml;`. Full-body
reads are NFKC-normalised and stripped of zero-width characters
(`untrusted-fence.ts:119-133`), so what the agent reads can differ from what it must
match, for example around non-breaking spaces. **Proposal:** match on a form with
entities decoded and NFC applied to both sides, mapped back to original offsets. At
minimum, on a failed match, retry the encoded and decoded variants and say which one
matched.

### T5. Fence granularity

Search results fence the title and the excerpt separately, each with the
`<!-- canary:… -->` comment (about 70 characters); 25 results make 50 fences.
**Proposal:** one fence per result block, still carrying the canary.

### T6. Tool list size and order

37 tools; static estimate about 26,000 characters of descriptions and 45,000–50,000 with
schemas. With deferred loading only the names load at start, but each loaded tool costs
its full description. The 2026-07-28 specification says `tools/list` SHOULD return tools
in a deterministic order, to help prompt caching.

## API and specification currency

### A1. v1 content endpoints

The server still reads old versions and lists attachments through v1 paths that are no
longer in Atlassian's published v1 OpenAPI document:
- `GET /wiki/rest/api/content/{id}?version=N&expand=body.storage`, used by
  `get_page_version`, `diff_page_versions` and `revert_page`;
- `GET /wiki/rest/api/content/{id}/version`, used by `get_page_versions`;
- `GET /wiki/rest/api/content/{id}/child/attachment`, used by `get_attachments`.

They still worked on 2026-10-06; the diff ran.

**Proposal.** Move the reads to v2: `GET /pages/{id}/versions`,
`GET /pages/{id}?version=N&body-format=storage` (check that it returns the historical
body), and `GET /pages/{id}/attachments`. Keep v1 only where v2 has no equivalent:
attachment upload, label add and remove, content state, CQL search, and move. Also check
that child listing uses `/direct-children`, because `/children` is deprecated.

### A2. Missing tools the API supports

- **`move_page`**, designed in investigate-bulk-operations.md. The v1
  `PUT /wiki/rest/api/content/{id}/move/{before|after|append}/{targetId}` is still
  documented. v2 can change `parentId` within a space but cannot set the order.
  *Observed:* a new child page landed last among its siblings, with no way to place it.
- **`delete_attachment`**: v2 `DELETE /attachments/{id}` moves the attachment to the
  trash, and `purge=true` on a trashed attachment removes it. Make purge a separate, gated
  step, with `requiresUserInteraction` (S4).
- **New attachment version**: v1 `POST`/`PUT /content/{id}/child/attachment` with an
  existing filename. *Observed:* uploads are create-only, so a corrected diagram has to
  get a new filename.

### A3. MCP

- **Annotations.** Add `title` and `openWorldHint` (it defaults to true; this server
  talks to an external system, so state it explicitly). Fill the gaps in R5. Clients must
  treat annotations as untrusted, so they never replace server-side enforcement.
- **Validation errors.** Return input-validation failures as tool results with
  `isError: true`, not as protocol errors, so the model can correct itself
  (2025-11-25).
- **`structuredContent`.** When it is present, Claude Code shows the agent the JSON only.
  Keep it lean. The current write results are compact; Atlassian's own server has an open
  complaint about echoing full bodies.
- **SDK floor.** `package.json` declares `@modelcontextprotocol/sdk` `^1.0.0`; 1.30.0 is
  installed. Set the floor to the oldest version that has the features used.
- **2026-07-28.** The protocol becomes stateless, elicitation moves into the
  `tools/call` result (`input_required`), and tasks become an extension. Older servers
  keep working, so plan a compatibility spike once the TypeScript SDK supports it.

### A4. Authentication *(unverified)*

Scoped API tokens must call `https://api.atlassian.com/ex/confluence/{cloudId}/...`
instead of the site URL. API tokens may now expire after at most a year. Check both, and
consider showing token expiry in `get_version` or `check_permissions`.

### A5. Correct the bulk-operations investigation

Its "Rate Limiting Context" presents the points-based quotas as applying to this server.
Add that they apply to Forge, Connect and OAuth 3LO apps, and that API-token traffic keeps
the burst limits (see R1).

## Proposed order

1. **Phase 1 (small, closes real gaps):** S1, S2, S3, S4, R5, A5, and the README line in R3.
2. **Phase 2 (reliability and fewer versions):** R1, R2, R3, S5, S6, S7.
3. **Phase 3 (largest token savings):** T1, T2, T3, T4, T5, T6.
4. **Phase 4 (currency and features):** A1, A2 (starting with `move_page`), A3, A4, R4.

## Open questions

1. Does Claude Code truncate parameter descriptions as well as tool descriptions?
2. Does v2 `GET /pages/{id}?version=N&body-format=storage` return the historical body in
   storage format for every version kind?
3. Are macro `local-id`s really regenerated on every version? If so, T1 loses nothing.
4. Should a read-scope setting (S5) also restrict `get_page` by space, or only search?

## Sources

- MCP specification versions and changelogs:
  https://modelcontextprotocol.io/specification/versioning,
  https://modelcontextprotocol.io/specification/2025-06-18/changelog,
  https://modelcontextprotocol.io/specification/2025-11-25/changelog,
  https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP tools (annotations, structured output):
  https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- MCP elicitation: https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- Confluence v1 deprecation timeline:
  https://community.developer.atlassian.com/t/update-to-confluence-v1-api-deprecation-timeline/79687
- Confluence OpenAPI documents: https://dac-static.atlassian.com/cloud/confluence/swagger.v3.json,
  https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json
- Confluence changelog (approval-required spaces, endpoint changes):
  https://developer.atlassian.com/cloud/confluence/changelog/
- Move endpoint:
  https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content---children-and-descendants/
- v2 attachments: https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-attachment/
- Rate limiting: https://developer.atlassian.com/cloud/confluence/rate-limiting/
- Macro local-id report *(community)*:
  https://community.developer.atlassian.com/t/mismatch-in-localid-of-confluence-macro/102293
- Scoped API tokens:
  https://support.atlassian.com/confluence/kb/scoped-api-tokens-in-confluence-cloud/
- Atlassian Rovo MCP server tools:
  https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/
- Claude Code MCP (output limits, tool search, `_meta` keys): https://code.claude.com/docs/en/mcp
- Claude Code custom tools (`readOnlyHint` and parallel calls):
  https://code.claude.com/docs/en/agent-sdk/custom-tools
