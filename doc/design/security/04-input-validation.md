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

## 8. CQL queries (user responsibility, documented)

`search_pages` takes a CQL string from the AI agent. Confluence's CQL is
not SQL and the attack surface is limited to the Atlassian backend, but the
server does **not** attempt to parse or validate CQL — it is passed through
as-is. The tool description warns the agent about this.

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
