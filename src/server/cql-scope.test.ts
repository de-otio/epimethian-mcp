import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@example.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

import { scopeCql } from "./cql-scope.js";

const DOCS = ["DOCS"] as const;

function ok(cql: string, keys: readonly string[] = DOCS): string {
  const r = scopeCql(cql, keys);
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.cql;
}

function reason(cql: string, keys: readonly string[] = DOCS): string {
  const r = scopeCql(cql, keys);
  if (r.ok) throw new Error(`expected rejection, got: ${r.cql}`);
  return r.reason;
}

describe("scopeCql", () => {
  it("wraps the caller query in parentheses and conjoins the space restriction", () => {
    expect(ok('title ~ "x"')).toBe('(title ~ "x") AND space in ("DOCS")');
  });

  it("parenthesises an OR query so the restriction binds to all of it", () => {
    expect(ok('title ~ "a" OR title ~ "b"')).toBe(
      '(title ~ "a" OR title ~ "b") AND space in ("DOCS")',
    );
  });

  it("lists every key and escapes quotes and backslashes in them", () => {
    expect(ok("type = page", ["DOCS", 'TE"AM', "BA\\CK"])).toBe(
      '(type = page) AND space in ("DOCS","TE\\"AM","BA\\\\CK")',
    );
  });

  it("splits a trailing ORDER BY off and re-appends it after the restriction", () => {
    expect(ok('title ~ "x" order  by lastmodified DESC, title')).toBe(
      '(title ~ "x") AND space in ("DOCS") ORDER BY lastmodified DESC, title',
    );
  });

  it("accepts a query that is only an ORDER BY clause", () => {
    expect(ok("ORDER BY title asc")).toBe('space in ("DOCS") ORDER BY title asc');
  });

  it("accepts an empty query and returns just the restriction", () => {
    expect(ok("   ")).toBe('space in ("DOCS")');
  });

  it("does not count parentheses inside literals of either quote type", () => {
    expect(ok(`title ~ "a)(" AND title ~ ')x('`)).toBe(
      `(title ~ "a)(" AND title ~ ')x(') AND space in ("DOCS")`,
    );
  });

  it("honours backslash escapes inside literals", () => {
    expect(ok(`title ~ 'it\\'s' AND title ~ "say \\"hi\\""`)).toContain("AND space in");
  });

  it("does not treat ORDER BY inside a literal as the clause", () => {
    expect(ok('title ~ "x ORDER BY y"')).toBe('(title ~ "x ORDER BY y") AND space in ("DOCS")');
  });

  it("rejects a query that closes the wrapper early", () => {
    expect(reason('title ~ "x") OR (space = "OTHER"')).toMatch(/parenthes/);
    expect(reason(") OR space = OTHER OR (")).toMatch(/parenthes/);
  });

  it("rejects unbalanced opening parentheses", () => {
    expect(reason('(title ~ "x"')).toMatch(/parenthes/);
  });

  it("rejects an unterminated literal", () => {
    expect(reason('title ~ "x')).toMatch(/unterminated/);
    expect(reason("title ~ 'x")).toMatch(/unterminated/);
  });

  it("rejects a literal whose closing quote is escaped, and a trailing backslash", () => {
    expect(reason('title ~ "x\\"')).toMatch(/unterminated/);
    expect(reason('title ~ "x\\')).toMatch(/unterminated/);
  });

  it("rejects a backslash outside a quoted literal (scanner/CQL lexer desync payload)", () => {
    // A lexer that reads `\"` outside a literal as an escaped quote would see
    // the `)` below as closing the wrapper, and AND binds tighter than OR.
    const payload = 'title ~ a\\" ) OR space = SECRET OR ( title ~ " b \\" c "';
    expect(reason(payload)).toMatch(/backslash/);
    expect(reason("title ~ a\\b")).toMatch(/backslash/);
    expect(reason("title ~ x\\")).toMatch(/backslash/);
    expect(reason('title ~ "ok" AND \\')).toMatch(/backslash/);
  });

  it("rejects ORDER BY inside parentheses", () => {
    expect(reason('(title ~ "x" ORDER BY title)')).toMatch(/ORDER BY/);
  });

  it("rejects a trailing ORDER BY that is not a plain field list", () => {
    expect(reason('title ~ "x" ORDER BY title; DROP')).toMatch(/ORDER BY/);
    expect(reason('title ~ "x" ORDER BY')).toMatch(/ORDER BY/);
    expect(reason('title ~ "x" ORDER BY (title)')).toMatch(/ORDER BY/);
    expect(reason('title ~ "x" ORDER BY title OR space = "OTHER"')).toMatch(/ORDER BY/);
    expect(reason('title ~ "x" ORDER BY title ORDER BY title')).toMatch(/ORDER BY/);
  });

  it("splits a plain trailing ORDER BY correctly (positive pin for the glued-keyword rejections)", () => {
    expect(ok("type=page ORDER BY title")).toBe('(type=page) AND space in ("DOCS") ORDER BY title');
    expect(ok("(type=page) ORDER BY title")).toBe(
      '((type=page)) AND space in ("DOCS") ORDER BY title',
    );
  });

  it("rejects an ORDER BY glued to the preceding text instead of splitting it off", () => {
    const glued = scopeCql("type=page.order by title", DOCS);
    expect(glued.ok).toBe(false);
    expect(reason("foo.order by bar")).toMatch(/ORDER BY/);
    expect(reason("(type=page)order by title")).toMatch(/ORDER BY/);
    expect(reason('title ~ "x"order by title')).toMatch(/ORDER BY/);
  });

  it("rejects an ORDER BY glued to the text after it", () => {
    expect(reason("type=page ORDER BY(title)")).toMatch(/ORDER BY/);
    expect(reason("type=page ORDER BY.title")).toMatch(/ORDER BY/);
  });

  it("does not treat a word merely containing 'order by' as the clause", () => {
    expect(ok("title ~ reorder")).toBe('(title ~ reorder) AND space in ("DOCS")');
  });

  it("rejects when no spaces are configured", () => {
    expect(reason('title ~ "x"', [])).toMatch(/no spaces/);
  });
});

// ---------------------------------------------------------------------------
// Property test against a small, independent CQL model.
//
// The model parses the text the scoper emits the way Confluence would
// (AND binds tighter than OR, NOT binds tightest, `\` escapes in literals) and
// evaluates it over a fixed universe of pages. A query the model cannot parse
// is a syntax error on the server and yields no results.
// ---------------------------------------------------------------------------

interface Doc {
  readonly space: string;
  readonly title: string;
}

const SPACES = ["DOCS", "TEAM", "OPS", "HR"] as const;
const TITLES = ["alpha", "beta"] as const;
const UNIVERSE: readonly Doc[] = SPACES.flatMap((space) =>
  TITLES.map((title) => ({ space, title })),
);
const SCOPE = ["DOCS", "TEAM"] as const;

type Tok = { t: "lit"; v: string } | { t: "word"; v: string } | { t: "sym"; v: string };

function tokenise(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"' || ch === "'") {
      let v = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new Error("unterminated literal");
        if (src[i] === "\\") {
          if (i + 1 >= src.length) throw new Error("dangling escape");
          v += src[i + 1];
          i += 2;
        } else if (src[i] === ch) {
          i++;
          break;
        } else {
          v += src[i++];
        }
      }
      out.push({ t: "lit", v });
    } else if ("(),=~".includes(ch)) {
      out.push({ t: "sym", v: ch });
      i++;
    } else if (ch === "!" && src[i + 1] === "=") {
      out.push({ t: "sym", v: "!=" });
      i += 2;
    } else if (/[A-Za-z0-9_.]/.test(ch)) {
      let v = "";
      while (i < src.length && /[A-Za-z0-9_.]/.test(src[i])) v += src[i++];
      out.push({ t: "word", v });
    } else {
      throw new Error(`bad character ${ch}`);
    }
  }
  return out;
}

type Pred = (d: Doc) => boolean;

/** Parse and evaluate; throws on a syntax error. */
function evaluate(src: string): Doc[] {
  const toks = tokenise(src);
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const isWord = (t: Tok | undefined, w: string): boolean =>
    t?.t === "word" && t.v.toLowerCase() === w;
  const sym = (v: string): void => {
    const t = toks[p++];
    if (t?.t !== "sym" || t.v !== v) throw new Error(`expected ${v}`);
  };
  const lit = (): string => {
    const t = toks[p++];
    if (t?.t !== "lit") throw new Error("expected literal");
    return t.v;
  };

  function field(name: string): (d: Doc) => string {
    if (name === "space" || name === "space.key") return (d) => d.space;
    if (name === "title") return (d) => d.title;
    throw new Error(`unknown field ${name}`);
  }

  function atom(): Pred {
    const f = toks[p++];
    if (f?.t !== "word") throw new Error("expected field");
    const get = field(f.v);
    const op = toks[p++];
    if (isWord(op, "in")) {
      sym("(");
      const vals = [lit()];
      while (peek()?.t === "sym" && (peek() as Tok).v === ",") {
        p++;
        vals.push(lit());
      }
      sym(")");
      return (d) => vals.includes(get(d));
    }
    if (op?.t !== "sym") throw new Error("expected operator");
    const v = lit();
    if (op.v === "=") return (d) => get(d) === v;
    if (op.v === "!=") return (d) => get(d) !== v;
    if (op.v === "~") return (d) => get(d).includes(v);
    throw new Error("bad operator");
  }

  function unary(): Pred {
    if (isWord(peek(), "not")) {
      p++;
      const inner = unary();
      return (d) => !inner(d);
    }
    const t = peek();
    if (t?.t === "sym" && t.v === "(") {
      p++;
      const inner = orExpr();
      sym(")");
      return inner;
    }
    return atom();
  }

  function andExpr(): Pred {
    let left = unary();
    while (isWord(peek(), "and")) {
      p++;
      const l = left;
      const r = unary();
      left = (d) => l(d) && r(d);
    }
    return left;
  }

  function orExpr(): Pred {
    let left = andExpr();
    while (isWord(peek(), "or")) {
      p++;
      const l = left;
      const r = andExpr();
      left = (d) => l(d) || r(d);
    }
    return left;
  }

  const pred = orExpr();
  if (isWord(peek(), "order")) {
    p++;
    if (!isWord(toks[p++], "by")) throw new Error("expected BY");
    for (;;) {
      const f = toks[p++];
      if (f?.t !== "word") throw new Error("expected order field");
      field(f.v);
      if (isWord(peek(), "asc") || isWord(peek(), "desc")) p++;
      const t = peek();
      if (t?.t === "sym" && t.v === ",") p++;
      else break;
    }
  }
  if (p !== toks.length) throw new Error("trailing tokens");
  return UNIVERSE.filter(pred);
}

const atomArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...SPACES).map((s) => `space = "${s}"`),
  fc.constantFrom(...SPACES).map((s) => `space != '${s}'`),
  fc.constantFrom(...TITLES).map((t) => `title ~ "${t}"`),
  fc
    .subarray([...SPACES], { minLength: 1 })
    .map((ss) => `space in (${ss.map((s) => `"${s}"`).join(", ")})`),
);

const exprArb: fc.Arbitrary<string> = fc.letrec<{ expr: string }>((tie) => ({
  expr: fc.oneof(
    { depthSize: "small" },
    atomArb,
    fc.tuple(tie("expr"), fc.constantFrom(" AND ", " OR ", " and ", " or "), tie("expr")).map(
      ([a, op, b]) => `${a}${op}${b}`,
    ),
    tie("expr").map((e) => `NOT (${e})`),
    tie("expr").map((e) => `(${e})`),
  ),
})).expr;

const orderByArb = fc.constantFrom("", " ORDER BY title", " order by title DESC, space asc");

const garbage = [
  ")",
  "(",
  '"',
  "'",
  "\\",
  " OR ",
  ' OR space = "HR"',
  ') OR (space = "HR"',
  '" OR space = "HR" OR title ~ "',
  "' OR space = 'HR",
  ' ORDER BY title',
  ") ORDER BY (",
  '\\" ) OR space = "HR" OR (title ~ "',
];

const mutatedArb = fc
  .tuple(exprArb, orderByArb, fc.nat(1000), fc.constantFrom(...garbage), fc.boolean())
  .map(([e, ob, at, g, mutate]) => {
    const base = `${e}${ob}`;
    if (!mutate) return base;
    const pos = at % (base.length + 1);
    return `${base.slice(0, pos)}${g}${base.slice(pos)}`;
  });

const SEED = 20261006;

describe("scopeCql property: results never leave the scope", () => {
  it("every accepted (possibly mutated) query, parsed by an independent model, stays inside the scope", () => {
    let accepted = 0;
    fc.assert(
      fc.property(mutatedArb, (input) => {
        const scoped = scopeCql(input, SCOPE);
        if (!scoped.ok) return true;
        accepted++;
        let docs: Doc[];
        try {
          docs = evaluate(scoped.cql);
        } catch {
          return true; // a syntax error on the server returns no results
        }
        return docs.every((d) => (SCOPE as readonly string[]).includes(d.space));
      }),
      { seed: SEED, numRuns: 1500 },
    );
    // Guard against a vacuous pass: the generator must produce accepted queries.
    expect(accepted).toBeGreaterThan(200);
  });

  it("a well-formed query keeps its meaning: scoped results equal original results within the scope", () => {
    fc.assert(
      fc.property(exprArb, orderByArb, (e, ob) => {
        const input = `${e}${ob}`;
        const original = evaluate(input);
        const scoped = scopeCql(input, SCOPE);
        if (!scoped.ok) return false;
        const expected = original.filter((d) => (SCOPE as readonly string[]).includes(d.space));
        expect(evaluate(scoped.cql)).toEqual(expected);
        return true;
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it("the model itself catches the classic precedence bug (sanity check of the oracle)", () => {
    // Naive concatenation without parentheses leaks OPS pages.
    const naive = 'title ~ "alpha" OR space = "OPS" AND space in ("DOCS")';
    expect(evaluate(naive).some((d) => d.space === "OPS")).toBe(true);
    // The scoper's output for the same input does not.
    const scoped = ok('title ~ "alpha" OR space = "OPS"', SCOPE);
    expect(evaluate(scoped).every((d) => d.space === "DOCS" || d.space === "TEAM")).toBe(true);
  });
});
