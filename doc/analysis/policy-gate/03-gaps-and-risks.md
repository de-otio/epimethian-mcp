# 3. Gaps and risks

## Corrections to the proposal

### "The agent cannot edit the policy" holds only for tool-only agents

The profile registry is a file owned by the same OS user as the agent. An
agent that has a shell or file tools (a coding agent) can rewrite it, and the
change takes effect at the next server start. The same applies to environment
variables in the MCP config.

What can be offered:

- Protection against an agent that has only the MCP tools: no tool reads or
  writes policy settings.
- Tamper evidence: log a hash of the effective policy at startup into the
  audit log, so a changed policy is visible afterwards.
- A real boundary needs the policy outside the user's write access: a
  root-owned file, or enforcement in a gateway the user does not control.
  That is an operator decision, not something the server can do alone.

### An override must not use the soft-confirmation path

Soft confirmation returns a token that the model passes back. For destructive
writes this is an accepted fallback. For a policy override it would be a flag
the model can set. A policy override therefore needs real elicitation or a
command run by a person at a terminal; on clients without elicitation the
block stands.

### A read audit log is new work

The mutation log has the right properties (no content, owner-only, retention
sweep) but records writes only. A read record is a new type with its own
volume: reads are far more frequent than writes.

## Cost per feature

| Feature | Cost driver |
|---|---|
| 2 Space scope on reads | One space resolution per content ID (cached 5 min). About 14 handlers to wire. Low. |
| 1, 3 Clearance and classification | `get_page` does not fetch labels or properties: one or two extra API calls per read, or a cache with an invalidation rule. A status macro in a table means parsing the body before deciding to withhold it. |
| 4 User placeholders | Storage-format reads must round-trip byte-exact into writes. Stripping `ri:account-id` needs a local map that survives for the session and is restored on every write path. |
| 5 Read budget | A counter parallel to the write budget. Low. "Crawl pattern" detection beyond a counter is heuristic. |
| 6 Detectors | False positives block legitimate work; false negatives create false assurance. Multilingual keyword lists need maintenance. |
| 8 Read log | New record type, retention, and volume control. |

## Data-loss risk

Feature 4 is the only one that touches the write path. If a placeholder is
not restored, a write removes a mention or replaces it with literal
placeholder text. The existing macro tokens have the same failure class and
are guarded by deletion checks; user placeholders would need the same guards
plus property-based round-trip tests. Features 1–3, 5 and 8 only withhold or
record and cannot lose wiki content.

## Bypass surface

A gate on `get_page` alone is not a gate. Each of these returns page content
or identities by another route:

- `get_page_by_title`, and `resolve_page_link` followed by a read
- `get_page_version` and `diff_page_versions` (old versions may hold content
  removed on purpose, and may predate a classification label)
- `get_comments`
- `get_attachments` and `download_attachment` (the file content does not pass
  through the model context directly, but lands on disk where the agent can
  read it)
- `search_pages` excerpts and `get_recent_changes` summaries
- `list_pages` and `get_page_children` (titles can be sensitive themselves)
- Blog posts, through every tool that accepts a content ID
- Write tools that echo content back: diffs, section reads before an update

The gate therefore belongs at one choke point that every handler passes, not
in individual handlers. A test that enumerates the registered tools and fails
for any tool without a declared gate decision would keep new tools from
becoming a bypass.

## Classification is only as good as the labels

- Many pages are unmarked or marked wrongly.
- The default for unmarked pages decides the feature's usefulness: a strict
  default blocks most of a wiki, a lenient one lets unmarked sensitive pages
  through.
- A label can change between the check and the read; the check and the body
  must come from the same version.
- Anyone who can edit a page can lower its label. The gate reflects the
  wiki's state, not the truth.

## Limits to state in user documentation

- The gate covers the Confluence path of this server only, not copy-paste,
  other MCP servers, or files the agent reads from disk.
- Free-text screening has false negatives. It lowers risk and guarantees
  nothing.
- Tiers and clearances are the organisation's decision. The tool enforces
  what a profile declares; it does not make usage GDPR-compliant by itself.
- The declared clearance is a statement by the person who configured the
  profile. The server cannot verify which model the client talks to.
- On a machine where the agent has file access, the policy is tamper-evident
  at best.
