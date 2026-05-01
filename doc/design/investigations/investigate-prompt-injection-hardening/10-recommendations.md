# 10. Recommended next steps

[← back to index](README.md)

Ranked by **damage-prevented-per-unit-of-effort**, not by severity
alone. Items early in this list land quickly and independently; later
items require design iteration and user approval.

## Tier 1 — small, surgical, land first

1. **Unicode sanitisation inside `fenceUntrusted`**
   ([04](04-unicode-sanitisation.md)). ~20 LOC in one file; closes
   the look-alike-bracket and tag-character bypasses. No schema
   changes, no client-visible breakage.
2. **Signal-scan annotation on fenced content**
   ([05](05-content-signal-scanning.md)). ~100 LOC; adds an
   attribute to the fence header when suspect patterns are detected.
   Agents that respect the fence now have a second, more specific
   cue. Stderr + mutation log entries give the operator a realtime
   signal.
3. **Canary + write-path fence detection**
   ([06.2, 6.3](06-cross-call-payload-propagation.md)). ~50 LOC in
   `safe-write.ts`; rejects writes whose body contains tool-response
   artefacts. Closes the round-trip echo attack cheaply.
4. **Mutation log on by default + stderr banner on destructive flags**
   ([09](09-audit-by-default.md)). One-line config flip plus a log
   formatter. Zero functional risk; improves forensics retroactively
   for every install.
5. **Version-message marker for destructive writes**
   ([09](09-audit-by-default.md)). Makes the flag set visible in
   Confluence's own history view — no dependency on whether the
   user enabled the local log.

## Tier 2 — moderate-effort, meaningful blast-radius reduction

6. **`source` parameter on destructive flags**
   ([03](03-flag-provenance.md)). Touches six tool schemas. Behavioural
   value (the agent has to lie twice) plus forensic value (the lie is
   logged). Default-inference keeps the well-aligned agent path
   unchanged.
7. **Default `max_length` on `get_page`**
   ([06.1](06-cross-call-payload-propagation.md)). Semver-minor
   breaking; requires a changelog entry and migration note. Caps
   context-saturation attack at the read layer.
8. **Elicitation on gated operations**
   ([07](07-human-in-the-loop.md)). The single most valuable defence
   in this investigation, but requires:
   - MCP capability detection at `initialize`.
   - Per-tool handler wrapping.
   - A well-tested degradation path for unsupported clients.
   - Documentation and a thoughtful default posture
     (refuse-on-unsupported vs. allow-on-unsupported).
   Probably one to two weeks of work including tests. Do not rush —
   the UX of the elicited prompt is the product.

## Tier 3 — architectural, ship only with a concrete user need

9. **Per-tool / per-space capability scoping**
   ([08](08-capability-scoping.md)). Registry schema change, CLI
   surface, per-handler gates. High value, but needs a concrete
   customer workflow to validate the shape before we commit. Pilot
   with a single extra flag (`disable_delete: true`) if needed
   sooner.
10. **OAuth scopes** — wait for Atlassian to expose granular write
    scopes. Capability scoping above is the interim substitute; the
    OAuth work can reuse its shape.

## What this list deliberately does not include

- **ML-based injection classifiers.** Out of scope; the bar for
  false positives in a content-editing tool is too high.
- **Automatic content redaction of "suspicious" text.** The fence
  convention is display-only; we escape, we do not alter.
  Reliability of round-trip updates is load-bearing.
- **Blocking agents from reading flagged pages.** A page with a
  high injection-signal score is still a legitimate page that a
  user may need to triage. The defence is annotation + provenance,
  not refusal.

## Sequencing

Tier 1 items (1-5) can all land in parallel; there are no ordering
constraints between them. Each is small enough for one PR and one
review cycle.

Tier 2 item 6 (`source` parameter) depends on Tier 1 item 4 (log
schema extension). Tier 2 item 8 (elicitation) is independent and
can start at any time.

Tier 3 item 9 is gated on product demand; do not implement
speculatively.

## Out of scope for this investigation

- **Client-side hardening.** The MCP client (Claude Code, Cursor)
  is a separate product with its own injection surface. We make
  server-side claims; client guarantees are the client's.
- **Model behavioural tuning.** Not our layer.
- **Preventing the agent from *reading* untrusted content.** The
  whole point of the tool is to let agents read Confluence; the
  defences are about what happens *after* the read.
- **A signed / authenticated variant of the fence.** The content-
  floor guard and elicitation layer together achieve most of what
  a signed fence would; adding cryptography to the fence itself is
  a 10× complexity jump for diminishing returns.
