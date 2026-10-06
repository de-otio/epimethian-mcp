# Input Validation & Injection Prevention

[← back to index](README.md)

Every input that crosses a trust boundary — user typing, env var, AI-agent
tool call, or Confluence API response — is validated against an explicit
schema or allowlist. This document enumerates those boundaries.

## 1. Profile names

Regex `/^[a-z0-9][a-z0-9-]{0,62}$/` validates at three chokepoints:

- CLI setup (`src/cli/setup.ts:69-74`)
- Keychain access (`src/shared/keychain.ts:13, 19-26`) — enforced in
  `accountForProfile()` regardless of caller-side checks
- Server startup (`src/server/confluence-client.ts:66`) — validates the
  `CONFLUENCE_PROFILE` env var

The mandatory `[a-z0-9]` first character prevents names like `-force` from
being interpreted as a flag by the `security` or `secret-tool` CLI. Together
with the use of `execFile`/`spawn` (never a shell), this closes the
argument-injection attack surface on keychain calls.

## 2. Setup URLs

Validated via `new URL()` plus targeted rejections:

- Must start with `https://` — hard error.
- `parsed.username` or `parsed.password` non-empty → hard error. (Prevents
  `https://user:pass@…` URLs that would bypass the keychain-stored token.)
- Contains `\n` or `\r` → hard error. (Prevents HTTP header injection if
  the URL is later concatenated into a log line or request.)
- Hostname does not end with `.atlassian.net` → warning (not error) so
  self-hosted Confluence remains usable, while flagging the unusual case.

See `src/cli/setup.ts:94-119`.

## 3. Account IDs (for user mentions in storage XML)

Accepted formats, checked against strict regexes before insertion into
`ri:account-id` attributes:

- Modern: `/^[0-9]+:[0-9a-fA-F-]{16,}$/` — e.g. `557058:uuid-with-dashes`
- Legacy: `/^5[0-9a-fA-F]{23}$/` — 24-char hex starting with `5`

Account IDs that fail both patterns are rejected. Because the charset is
`[0-9a-fA-F:-]` only, they contain no XML-significant characters even if
the escape layer were to fail.

See `src/server/converter/account-id-validator.ts`.

## 4. Filenames (for attachments)

Rejected:

- Empty string.
- Length > 255 bytes (POSIX and Windows limit).
- Contains `/` or `\` (directory separators).
- Contains null or C0 / C1 control characters.
- Starts with `.` (hidden files, `..`, and related).
- Contains `..` as a path segment.

See `src/server/converter/filename-validator.ts`.

## 5. XML escaping (storage-format output)

Three escape helpers in `src/server/converter/escape.ts`:

- `escapeXmlAttr` — escapes `&`, `<`, `>`, `"`, `'`, and all control
  characters as numeric character references. Used for all attributes.
- `escapeXmlText` — escapes `&`, `<`, `>`. Used for text content.
- `escapeCdata` — splits `]]>` sequences into `]]]]><![CDATA[>` to prevent
  CDATA breakout when user content is embedded in `<![CDATA[…]]>` sections.

These are the last line of defence. Any route that produces storage XML
passes through them.

## 6. Macro allowlist

Confluence's storage format can invoke arbitrary named macros, some of
which execute HTML or embed external resources. The server allowlists a
**source-code-level, frozen set**:

```
info, note, warning, tip, success, panel, code, expand, toc, status,
anchor, excerpt, excerpt-include, drawio, children, jira
```

The allowlist is `Object.freeze()`-d and not runtime-configurable — a
compromised config file cannot widen the attack surface. Lookups are exact,
case-sensitive, and constant-time (via `Set`).

See `src/server/converter/allowlist.ts`.

## 7. Confluence API response validation (Zod)

Responses from Confluence are parsed with Zod schemas before their fields
are used. A server response that drops required fields or returns an
unexpected shape causes a parse error rather than an unchecked field
access.

See the schemas in `src/server/confluence-client.ts:207+` (`PageSchema`,
`CommentSchema`, etc.).

## 8. CQL queries (scoping and redaction)

`search_pages` takes a CQL string from the AI agent. Confluence's CQL is
not SQL and the attack surface is limited to the Atlassian backend, so the
server does **not** try to validate CQL in general: without scoping it is
passed through as-is, and the tool description warns the agent about this.

When a profile sets `read_spaces` (and the call does not pass
`all_spaces: true`), the query is scoped before it is sent. `scopeCql`
wraps it as

```
(<cql>) AND space in ("K1","K2") [ORDER BY ...]
```

The parentheses make the restriction bind to the whole query, so
`a OR b` cannot widen it. That only holds if the caller's text cannot
close the wrapper early or hide a token inside a literal, so the query is
scanned first and **refused** (not repaired) when:

- a quoted literal (`'` or `"`, with backslash escapes) is not terminated;
- parenthesis depth goes below zero, or ends above zero, outside literals;
- `ORDER BY` appears inside parentheses, or the trailing `ORDER BY` is not
  `field [ASC|DESC] (, field [ASC|DESC])*`.

A trailing `ORDER BY` is split off before wrapping, because CQL only
allows it at the end. Space keys are escaped with `escapeCqlString`. When
`read_spaces_enforced` is set, `all_spaces: true` is an error rather than
a widening. The profile settings are validated at runtime; an invalid
combination disables `search_pages` and `get_recent_changes` with a message naming the field, and
never echoes values.

Scoping is request-side only. It trusts Confluence to honour the
`space in (...)` conjunct and does not filter result bodies, so it limits
what an agent searches by default; it is not a data boundary.

### Search result redaction

Search results are cleaned in a fixed pipeline
(`src/server/search-redact.ts`), applied to titles and excerpts only:

1. Strip the `@@@hl@@@` / `@@@endhl@@@` highlight markers the v1 search
   endpoint adds. This always runs, whether or not redaction is configured.
2. If the profile sets `redact_patterns`: decode HTML entities, so
   `se&#99;ret` is seen as `secret`.
3. Normalise to NFKC, remove the fence strip set (zero-width, bidi, tag
   characters) and a few more invisible characters such as the soft hyphen.
4. Repeat steps 1 to 3 until the text stops changing, because each can
   build the input of another (`&#64;` decodes to a marker character). Text
   that has not settled after a fixed number of passes is hiding something
   and is replaced entirely.
5. Match each pattern as an escaped literal, case-insensitively with
   Unicode case folding (flags `giu`), longest pattern first. A pattern is
   never interpreted as a regular expression, so it cannot cause ReDoS.
6. Replace every match with `[redacted]`.

Patterns get the same normalisation as the text. A pattern that normalises
to nothing is rejected at configuration time. Patterns are never written to
errors or logs. Each result is then fenced as its own untrusted block
(ID, Space, Title, Excerpt).

Redaction is hygiene, not a security boundary: it only sees what the search
endpoint returns, and it does not hide that a result exists.

## 9. Child-process invocation

All keychain-touching child processes use `execFile` or `spawn` with an
explicit argument array. `exec` (which passes the command through a shell)
is **never** used for user-derived input. Combined with the profile-name
regex, this closes metacharacter-injection routes even for malformed
profile names that somehow bypass earlier validation.

See `src/shared/keychain.ts:38-107`.

## 10. Error message redaction

All Confluence API errors surfaced to the MCP client are passed through
`sanitizeError()`:

- `Basic [A-Za-z0-9+/=]{20,}` → `Basic [REDACTED]`
- `Bearer [A-Za-z0-9._-]{20,}` → `Bearer [REDACTED]`
- `Authorization:\s*\S+` → `Authorization: [REDACTED]` (case-insensitive)
- Truncated to 500 characters.

See `src/server/confluence-client.ts:451-460`.

Raw error bodies are still logged to **stderr** (server logs, not tool
output) to aid debugging. Treat server stderr as sensitive — if your MCP
client surfaces stderr to a user-visible channel, credentials could leak
via a novel error format that `sanitizeError` doesn't catch.

## 11. Download destinations

`download_attachment` writes Confluence-controlled bytes to a local path,
so the destination is validated before anything is fetched or written:

- The resolved path must be under `process.cwd()`.
- When `output_path` is omitted, the attachment's own filename is checked
  with the rules in section 4 and rejected, not sanitised.
- **Dot-segment rule.** Any path segment below the working directory that
  starts with `.` is refused: `.git`, `.claude`, `.github`, `.vscode`,
  `.env` and any other dot-file or dot-directory. These are the places an
  attacker-controlled file would be executed or trusted by tooling
  (hooks, workflows, agent settings, environment files).
- Files are never created executable, and an overwrite clears any execute,
  setuid and setgid bits the old file had.
- The file is opened with `O_NOFOLLOW | O_EXCL`, so a symlink at the
  destination is not followed and an existing file is not replaced unless
  `overwrite: true`.

See `src/shared/safe-fs.ts` and the `download_attachment` section of
[../03-tools.md](../03-tools.md).
