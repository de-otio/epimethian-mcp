# 1. Proposal

This file records the proposal as received. The check against the code is in
[02-code-findings.md](02-code-findings.md), the corrections in
[03-gaps-and-risks.md](03-gaps-and-risks.md).

## Background

A typical company policy checks two independent conditions before data may go
to a model:

1. The model's clearance must cover the data's confidentiality level.
2. Personal data may only go to models approved for it.

On top of that, GDPR purpose limitation and data minimisation mean that "a
whole space as context" is a violation regardless of the model.

### Personal-data tiers

| Tier | Meaning | Examples |
|---|---|---|
| A | Incidental business metadata | Names as author, owner or mention |
| B | Substantive personal data | Mail content, transcripts, HR records, end-user data |
| C | Special categories (GDPR Art. 9) | Health, religion, union membership |

## Design principle

Prefer measures that need no detection: scoping, classification, stripping
and volume caps. Content detection is a second layer. A detector misses
things; an allowlist does not.

## Proposed features

1. **Declared model clearance per profile.** The server cannot know which
   model the client uses, so the profile declares it: the maximum
   confidentiality level and the personal-data tier allowed. Every read is
   checked against the declaration.

   ```yaml
   profile: some-cloud-model
   clearance: { max_classification: confidential, personal_data: tier_a }
   spaces: { allow: [DEV, DOCS, "~me"], deny: [HR, "~*"] }
   budget: { pages_per_session: 50, pages_per_space: 20 }
   ```

2. **Space scoping on every read tool.** The scope applies to all reads, not
   only to search.
3. **Classification gate.** Read a classification from page properties (for
   example a status macro in a page-properties table), from labels, and from
   a per-space default, with a configurable default for unmarked pages. A
   page above the profile's clearance returns only title, level and reason,
   not the body.
4. **Metadata minimisation by default.** Replace page owner, author, last
   editor and mentions with stable placeholders (for example `[[user:1]]`)
   that are resolved locally on write, like the existing `[[epi:T…]]` macro
   tokens.
5. **Volume budget.** Cap pages per session and per space; refuse crawl
   patterns (list a space, then fetch everything).
6. **Content screening (second layer).** Local, deterministic detectors for
   stronger personal-data signals: e-mail addresses, phone numbers, IBANs,
   birth dates, and configurable multilingual keyword lists (sick note,
   salary, warning letter, job application). On a hit: block, redact, or ask
   the human to confirm. An optional classifier only via a user-configured
   local or on-premises model endpoint, never a third-party model.
7. **Preflight tool.** `check_clearance(page_id)` returns classification,
   detector hits and verdict without the body.
8. **Audit log.** A local record per read: page ID, version, classification,
   byte count, detector hits, profile; no content. Supports incident scoping
   and breach documentation.
9. **Enforcement outside the model.** The agent cannot edit the policy;
   blocks fail closed; an override needs a human at a terminal or an MCP
   elicitation, never a tool flag the model can set. Refusal messages say
   why and what to do instead.

## Order suggested by the proposal

- v1: features 1–5 and 8 (all deterministic)
- v2: content detectors and the preflight tool
- v3: local-model classifier

[04-scope-options.md](04-scope-options.md) proposes a different cut. It also
changes two features: feature 7 becomes a CLI command instead of an agent
tool, and feature 4 is split into omitting fields (default) and placeholders
(opt-in).
