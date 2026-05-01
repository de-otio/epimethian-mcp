# 8. Capability scoping

[← back to index](README.md)

## Problem

A profile today is either `readOnly` or it has all 30+ tools enabled.
There is no finer granularity. This means:

- A "triage bot" profile that should only read and comment cannot be
  configured — comments require the same privileges as `delete_page`.
- A "content-generation" profile that creates pages under a single
  parent cannot be constrained to that subtree — it has
  `delete_page` available at all times.
- A "cleanup" profile that should only operate on pages tagged
  `epimethian-draft` has no way to express that constraint.

The narrower the capability grant, the smaller the blast radius of a
successful injection. The current all-or-nothing model leaves the
agent's judgement as the only filter between a hijack attempt and a
`delete_page` of an unrelated critical document.

## Proposal

### 8.1 Per-tool allow/deny list per profile

Extend the profile registry (`~/.config/epimethian-mcp/profiles.json`)
with per-tool flags:

```json
{
  "profiles": ["acme-triage", "acme-author"],
  "settings": {
    "acme-triage": {
      "readOnly": false,
      "allowed_tools": ["get_page", "search_pages", "create_comment", "resolve_comment"]
    },
    "acme-author": {
      "allowed_tools_writes": ["create_page", "update_page", "append_to_page"],
      "denied_tools": ["delete_page", "revert_page"]
    }
  }
}
```

Semantics:

- `allowed_tools`: whitelist. If set, only listed tools are
  registered. Omitted tools don't appear to the agent at all.
- `denied_tools`: blacklist (subset-sugar). Every tool except the
  listed ones is registered.
- The two fields are mutually exclusive; validation rejects profiles
  that set both.
- Unknown tool names are rejected at startup, not silently ignored.

CLI flag: `epimethian-mcp profiles --deny-tools delete_page,revert_page acme-author`.

### 8.2 Per-space allowlist

Extend with an optional `spaces` field:

```json
"acme-author": {
  "spaces": ["DOCS", "SANDBOX"]
}
```

Effect: every tool that takes a `space_key` or implicitly targets a
space (via `page_id` resolution) is gated. `create_page` with
`space_key: "OPS"` is rejected on `acme-author`; `delete_page` on a
page ID resolving to `space_key: "OPS"` is rejected.

Enforcement happens in the handler before the Confluence call. The
`space_key` is validated synchronously; the page-ID-to-space
resolution requires one extra `get_page` call (metadata only). Cache
the mapping in `pageCache` to avoid the double-fetch on repeat
access.

### 8.3 Parent-subtree allowlist

Narrower than per-space: "this profile can only operate on pages
descended from page ID N". Enforcement: resolve page → walk ancestors
via `get_page_children` reverse or an ancestors API → reject if N is
not an ancestor.

Expensive on every call; cache ancestry. Ship only if a real user
needs it — optional feature gated on a design request.

### 8.4 Label-based allowlist

"This profile can only operate on pages that carry label L at
read-time." Easy to implement (one `get_labels` check before any
write); useful for a "cleanup agent only touches pages marked
`draft`" workflow.

## Threat-model coverage

Capability scoping does not prevent injection; it bounds the damage
a successful injection can do. An agent whose profile can only
create pages under `DOCS/Drafts` and can never delete cannot be
hijacked into deleting a restricted page, no matter how clever the
payload.

| Attack class       | Covered how                                                 |
| ------------------ | ----------------------------------------------------------- |
| A (direct)         | If the attacker's demanded tool is not in `allowed_tools`, the call fails at registration lookup, not at runtime. |
| B (parameter-smuggling) | Per-space allowlist rejects page IDs outside the allowed set. |
| D (second-order)   | The round-trip target is still bounded by the allowlist.    |

## Costs

- Registry schema change (breaking for profiles.json consumers).
- Handler wrappers: ~20 LOC per tool, but repetitive.
- One additional `get_page` metadata call per space-gated write
  when the mapping isn't cached.
- Documentation burden: users must know which tools do what before
  they can deny-list intelligently.

## Relationship to read-only mode

`readOnly: true` is equivalent to `allowed_tools` = `READ_ONLY_TOOLS`
(the existing set in `src/server/index.ts:162-180`). A migration
path: treat `readOnly: true` as syntactic sugar for that allowlist,
but don't silently expand — users should opt into the more granular
model deliberately.

## Alternatives considered

- **Per-conversation tool opt-in**: the user toggles tools on and
  off per MCP session. UX-heavy and not a server-side concern.
- **OAuth scopes**: the right answer long-term, but Confluence Cloud
  doesn't expose granular write scopes yet. Atlassian Rovo's
  official server is waiting for the same thing.
- **A `capabilities` subcommand in the CLI** that prints the
  effective capability set for each profile: cheap to add, useful
  for auditing. Include with the implementation.
