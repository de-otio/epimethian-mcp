/**
 * 0-T7: every `epimethian-mcp <command>` that the server or the shared code
 * tells a person to run names a command `src/cli/index.ts` dispatches, and
 * every `--flag` after it is one that command's module handles. 7.6.0's
 * write-allowlist refusal told people to run `epimethian-mcp profiles
 * --add-space`, a flag that never existed.
 *
 * Source scan: string literals and template chunks (parsed with the
 * TypeScript compiler, so comments are not scanned) in src/server/**,
 * src/shared/** and src/cli/** (non-test files). Rendered scan: every
 * `describeUnreadable` kind (with and without a backup) and every
 * `recoveryText` reason, because their commands are built at run time.
 * Subcommand dispatchers (step A, e.g. `policy setup`) are not checked here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describeUnreadable, type UnreadableReason } from "../shared/profiles.js";
import { recoveryText } from "../server/index.js";

const SRC = resolve(__dirname, "..");
const CLI_INDEX = join(SRC, "cli", "index.ts");

/** A placeholder for `${...}` inside a template: neither text nor a boundary. */
const SUBST = "\u0000";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** Every string literal and whole template (substitutions as SUBST) in a file. */
function stringLiterals(path: string): string[] {
  const sf = ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text + node.templateSpans.map((s) => SUBST + s.literal.text).join(""));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface CommandMention {
  readonly command: string;
  readonly flags: readonly string[];
  readonly text: string;
}

/**
 * The `epimethian-mcp <word>` mentions in `text` that are commands, not
 * prose ("epimethian-mcp caps writes", "epimethian-mcp v1.2"). A mention is
 * a command when it is in backticks, follows "run" or "run:", or the word is
 * followed by a flag or by the end of the text.
 */
export function commandMentions(text: string): CommandMention[] {
  const out: CommandMention[] = [];
  const re = /epimethian-mcp ([a-z][a-z0-9-]*)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    const after = text.slice(m.index + m[0].length);
    const quoted = before.endsWith("`");
    const afterRun = /\brun:? $/i.test(before);
    const flagNext = /^ --[a-z]/.test(after);
    const endsHere = after === "" || /^[`'"),.;]?(?:$|\s*\n)/.test(after) || /^[`'")]/.test(after);
    if (!(quoted || afterRun || flagNext || endsHere)) continue;
    // Flags: the tokens after the command up to the end of the command text.
    const rest = after.split(/[`\n\u0000]|\. |; /)[0] ?? "";
    const flags = rest
      .split(/\s+/)
      .filter((t) => t.startsWith("--"))
      .map((t) => t.replace(/[^a-z0-9-]+$/i, ""));
    out.push({ command: m[1]!, flags, text });
  }
  return out;
}

/** The commands `src/cli/index.ts` dispatches (`command === "x"`). */
function dispatchedCommands(): Set<string> {
  const text = readFileSync(CLI_INDEX, "utf-8");
  return new Set([...text.matchAll(/command === "([a-z][a-z0-9-]*)"/g)].map((m) => m[1]!));
}

/** Flags a command handles: string literals "--x" in its module, cli/index.ts and profile-arg.ts. */
function handledFlags(command: string): Set<string> {
  const files = [CLI_INDEX, join(SRC, "cli", "profile-arg.ts"), join(SRC, "cli", `${command}.ts`)].filter(existsSync);
  const flags = new Set<string>();
  for (const f of files) {
    for (const lit of stringLiterals(f)) {
      for (const m of lit.matchAll(/--[a-z][a-z0-9-]*/g)) flags.add(m[0]);
    }
  }
  return flags;
}

function problems(mentions: readonly CommandMention[]): string[] {
  const commands = dispatchedCommands();
  const out: string[] = [];
  for (const m of mentions) {
    if (!commands.has(m.command)) {
      out.push(`"epimethian-mcp ${m.command}" is not a command (in: ${JSON.stringify(m.text.slice(0, 120))})`);
      continue;
    }
    const known = handledFlags(m.command);
    for (const flag of m.flags) {
      if (!known.has(flag)) out.push(`"epimethian-mcp ${m.command} ${flag}": ${flag} is not handled`);
    }
  }
  return out;
}

describe("commandMentions (the detector itself)", () => {
  it("finds the 7.6.0 bug: profiles --add-space", () => {
    const found = commandMentions("Either configure it (CLI: `epimethian-mcp profiles --add-space DEV`) or retarget.");
    expect(found.map((m) => [m.command, m.flags])).toEqual([["profiles", ["--add-space"]]]);
    expect(problems(found)).toEqual(['"epimethian-mcp profiles --add-space": --add-space is not handled']);
  });

  it("finds a command after run:, in backticks, with flags, and at the end", () => {
    const found = commandMentions(
      `Run \`epimethian-mcp setup --profile ${SUBST}\` first. To enable writes, run: epimethian-mcp profiles --set-read-write x. then run: epimethian-mcp policy`,
    );
    expect(found.map((m) => [m.command, m.flags])).toEqual([
      ["setup", ["--profile"]],
      ["profiles", ["--set-read-write"]],
      ["policy", []],
    ]);
    expect(problems(found)).toEqual([expect.stringContaining('"epimethian-mcp policy" is not a command')]);
  });

  it("ignores prose", () => {
    expect(
      commandMentions(
        `epimethian-mcp caps writes per session; epimethian-mcp v${SUBST} is current; Another epimethian-mcp command is busy; epimethian-mcp server version`,
      ),
    ).toEqual([]);
  });
});

describe("0-T7 commands named in string literals exist", () => {
  const files = ["server", "shared", "cli"].flatMap((d) => sourceFiles(join(SRC, d)));

  it("scans a meaningful set of files and finds commands", () => {
    expect(files.length).toBeGreaterThan(50);
    const all = files.flatMap((f) => stringLiterals(f).flatMap(commandMentions));
    const names = new Set(all.map((m) => m.command));
    for (const c of ["setup", "upgrade", "profiles"]) expect(names).toContain(c);
  });

  it("every command and flag is real", () => {
    const found = files.flatMap((f) =>
      stringLiterals(f)
        .flatMap(commandMentions)
        .map((m) => ({ ...m, text: `${f.slice(SRC.length + 1)}: ${m.text}` })),
    );
    expect(problems(found)).toEqual([]);
  });
});

describe("0-T7 rendered registry texts name only real commands (orchestrator note)", () => {
  const path = "/home/u/.config/epimethian-mcp/profiles.json";
  const reasons: readonly UnreadableReason[] = [
    { kind: "parse-error", line: 2, column: 4 },
    { kind: "parse-error" },
    { kind: "unexpected-shape" },
    { kind: "unsafe-permissions", target: "file", problem: "mode" },
    { kind: "unsafe-permissions", target: "file", problem: "owner" },
    { kind: "unsafe-permissions", target: "directory", problem: "mode" },
    { kind: "unsafe-permissions", target: "directory", problem: "owner" },
    { kind: "not-regular-file" },
    { kind: "io-error", errno: "EACCES" },
  ];

  it("every describeUnreadable fix line, with and without .bak, and every recovery text", () => {
    const texts: string[] = [];
    for (const r of reasons) {
      for (const backup of [undefined, { path: `${path}.bak`, fitsAnchor: undefined }]) {
        const d = describeUnreadable(r, path, "work", backup);
        texts.push(d.what, d.fix);
        const t = recoveryText("work", { kind: "registry-unreadable", ...d });
        texts.push(t.instructions, t.description, t.text);
      }
    }
    const missing = recoveryText("work", { kind: "profile-missing" });
    texts.push(missing.instructions, missing.description, missing.text);

    const found = texts.flatMap(commandMentions);
    expect(found.length).toBeGreaterThan(0);
    expect(problems(found)).toEqual([]);
    expect(texts.join("\n")).not.toMatch(/epimethian-mcp policy/);
  });
});
