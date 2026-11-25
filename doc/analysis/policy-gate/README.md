# Policy gate: analysis

Status: analysis, 2026-11-25. Scope and order are decided (14 decisions in
[04-scope-options.md](04-scope-options.md)). Not a spec. Nothing described
here is built.

## Use case

> As a user of Epimethian, I would like Epimethian to help me keep from
> sending unauthorized data to the model provider. I want it to help me use
> the MCP server in a way that is compliant with GDPR and company policy.

The MCP server is the last point before wiki content enters the model
context. It can therefore decide which data is returned, how much of it, and
under which declared conditions.

## Summary

- The server has no read boundary today. `read_spaces_enforced` covers
  `search_pages` and `get_recent_changes` only; every other read tool returns
  any page the token can read.
- The building block for a boundary exists: `assertSpaceAllowed` resolves a
  page, blog post or comment to its space and fails closed. Only write tools
  call it.
- Names and account IDs of wiki users reach the model through several read
  tools and through storage-format bodies.
- There is no audit record of reads. The mutation log covers writes.
- Three assumptions of the proposal do not hold as written: the policy file
  is writable by an agent with a shell, the soft-confirmation fallback lets
  the model pass the confirmation itself, and a read log does not exist yet.
- An unreadable profile registry is treated as an empty one, so configured
  restrictions appear to stop applying (read from the code, not yet
  reproduced). A policy gate needs this to fail closed first.
- Most contact with the feature is a refusal that an agent relays to a
  person. The recommendation therefore fixes the shape of refusals,
  announces the limits to the agent at startup, and starts content rules in
  a report-only mode.
- Recommended order: fix the registry fail-open (step 0), then the space
  scope on every read tool with a guided `policy setup` (step A), then the
  read log and budget (step B). Approvals, classification, metadata and
  detectors follow as separately specified steps.
  [04-scope-options.md](04-scope-options.md) is the consolidated
  recommendation.

## Documents

| File | Content |
|---|---|
| [01-proposal.md](01-proposal.md) | Background, design principle, the nine proposed features |
| [02-code-findings.md](02-code-findings.md) | What the code does today, with file references |
| [03-gaps-and-risks.md](03-gaps-and-risks.md) | Corrections to the proposal, costs, bypass surface, limits to state in user docs |
| [04-scope-options.md](04-scope-options.md) | Consolidated recommendation: design rules, steps, decisions |
| [05-lessons-from-repo-aegis.md](05-lessons-from-repo-aegis.md) | Design decisions from a neighbouring guard that transfer |
| [06-usability-review.md](06-usability-review.md) | Review of the proposal for ease of use; recommended commands and first-run flow |

## Conventions

Examples use placeholder space keys (`HR`, `DEV`, `DOCS`) and placeholder
classification levels (`public`, `internal`, `confidential`, `secret`). The
levels and tiers an organisation uses are its own policy decision; the tool
would only enforce what a profile declares.
