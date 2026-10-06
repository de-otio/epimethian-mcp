/**
 * Read scoping for `search_pages` (S5, M7).
 *
 * `scopeCql` conjoins a caller-supplied CQL query with a space restriction:
 *
 *     (<cql>) AND space in ("K1","K2") [ORDER BY ...]
 *
 * The parentheses make the restriction bind to the WHOLE caller query, so an
 * `a OR b` predicate cannot widen it. That only holds if the caller's text
 * cannot close the wrapper early or hide a token inside a literal, so the
 * query is scanned first and rejected when:
 *
 *   - a quoted literal (`'` or `"`, backslash escapes) is not terminated;
 *   - parenthesis depth goes below zero at any point, or ends non-zero
 *     (outside literals);
 *   - `ORDER BY` appears inside parentheses, or the trailing `ORDER BY`
 *     clause is not `field [ASC|DESC] (, field [ASC|DESC])*`.
 *
 * A trailing `ORDER BY` is split off before wrapping, because it is only valid
 * at the end of a CQL query. Pure; no I/O.
 *
 * Limits: this is a request-side restriction. It trusts the server to honour
 * the `space in (...)` conjunct, and it does not filter result bodies.
 */

import { escapeCqlString } from "./confluence-client.js";

export type ScopeResult =
  | { readonly ok: true; readonly cql: string }
  | { readonly ok: false; readonly reason: string };

const WORD_CHAR_RE = /[A-Za-z0-9_]/;
const ORDER_BY_RE = /order\s+by\b/iy;
const ORDER_FIELD = "[A-Za-z_][A-Za-z0-9_.]*";
const ORDER_TERM = `${ORDER_FIELD}(?:\\s+(?:asc|desc))?`;
const ORDER_CLAUSE_RE = new RegExp(`^${ORDER_TERM}(?:\\s*,\\s*${ORDER_TERM})*$`, "i");

const reject = (reason: string): ScopeResult => ({ ok: false, reason });

export function scopeCql(cql: string, spaceKeys: readonly string[]): ScopeResult {
  if (spaceKeys.length === 0) {
    return reject("no spaces are configured for search");
  }

  let quote: string | null = null;
  let depth = 0;
  let orderByAt = -1;
  for (let i = 0; i < cql.length; i++) {
    const ch = cql[i];
    if (quote !== null) {
      if (ch === "\\") {
        i++; // the escaped character cannot close the literal
        if (i >= cql.length) return reject("unterminated string literal");
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth < 0) return reject("unbalanced parentheses");
    } else if ((ch === "o" || ch === "O") && (i === 0 || !WORD_CHAR_RE.test(cql[i - 1]))) {
      ORDER_BY_RE.lastIndex = i;
      if (ORDER_BY_RE.test(cql)) {
        if (depth !== 0) return reject("ORDER BY is only allowed at the end of the query");
        orderByAt = i;
        break;
      }
    }
  }
  if (orderByAt < 0) {
    if (quote !== null) return reject("unterminated string literal");
    if (depth !== 0) return reject("unbalanced parentheses");
  }

  const predicate = (orderByAt < 0 ? cql : cql.slice(0, orderByAt)).trim();
  let orderBy = "";
  if (orderByAt >= 0) {
    const clause = cql.slice(orderByAt).replace(/^order\s+by/i, "").trim();
    if (!ORDER_CLAUSE_RE.test(clause)) {
      return reject("ORDER BY must be a comma-separated list of `field [ASC|DESC]`");
    }
    orderBy = ` ORDER BY ${clause}`;
  }

  const keys = spaceKeys.map((k) => `"${escapeCqlString(k)}"`).join(",");
  const restriction = `space in (${keys})`;
  const scoped = predicate === "" ? restriction : `(${predicate}) AND ${restriction}`;
  return { ok: true, cql: `${scoped}${orderBy}` };
}
