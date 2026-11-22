import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { resolveProfileArg } from "./profile-arg.js";

const ok = (profile: string | undefined) => ({ ok: true, profile });

describe("resolveProfileArg", () => {
  it.each([
    [[], {}, undefined],
    [["--profile", "acme"], {}, "acme"],
    [["--profile=acme"], {}, "acme"],
    [[], { CONFLUENCE_PROFILE: "acme" }, "acme"],
    [["--profile", "acme"], { CONFLUENCE_PROFILE: "acme" }, "acme"],
    [["--profile", "acme"], { CONFLUENCE_PROFILE: "" }, "acme"],
    [["--profile", "acme", "--profile", "acme"], {}, "acme"],
    [["--other", "x", "--profile", "globex"], {}, "globex"],
  ] as const)("argv %j env %j → %s", (argv, env, profile) => {
    expect(resolveProfileArg(argv, env)).toEqual(ok(profile));
  });

  it("refuses when --profile and CONFLUENCE_PROFILE disagree, naming both", () => {
    const r = resolveProfileArg(["--profile", "globex"], { CONFLUENCE_PROFILE: "acme" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('"globex"');
      expect(r.error).toContain('"acme"');
      expect(r.error).toContain("CONFLUENCE_PROFILE");
    }
  });

  it.each([
    [["--profile"]],
    [["--profile", "--yes"]],
    [["--profile", "-x"]],
    [["--profile="]],
    [["--profile", "bad name"]],
    [["--profile", "Acme"]],
    [["--profile", "../acme"]],
    [["--profile", "acme", "--profile", "globex"]],
  ])("refuses %j", (argv) => {
    expect(resolveProfileArg(argv, {}).ok).toBe(false);
  });

  it("property: the result is the single agreed name or an error, never a third value", () => {
    const name = fc.constantFrom("acme", "globex", "initech", "Bad", "bad name", "-x", "");
    const argvPart = fc.oneof(
      fc.tuple(fc.constant("--profile"), name).map(([f, v]) => [f, v]),
      name.map((v) => [`--profile=${v}`]),
      fc.constant(["--profile"]),
      fc.constantFrom(["--yes"], ["setup"], ["acme"], ["--client", "cursor"]).map((a) => [...a]),
    );
    const argvArb = fc.array(argvPart, { maxLength: 4 }).map((parts) => parts.flat());
    const envArb = fc.option(name, { nil: undefined });

    fc.assert(
      fc.property(argvArb, envArb, (argv, envProfile) => {
        const env = envProfile === undefined ? {} : { CONFLUENCE_PROFILE: envProfile };
        const r = resolveProfileArg(argv, env);
        if (!r.ok) return; // an error is always an acceptable answer

        // Every name the flag supplied, in either form.
        const flagged: string[] = [];
        for (let i = 0; i < argv.length; i++) {
          if (argv[i] === "--profile") flagged.push(argv[++i]);
          else if (argv[i].startsWith("--profile=")) flagged.push(argv[i].slice("--profile=".length));
        }
        const sources = [...flagged, ...(envProfile ? [envProfile] : [])];

        if (sources.length === 0) {
          expect(r.profile).toBeUndefined();
        } else {
          // One agreed name, taken from the inputs; never invented, never one of two different ones.
          expect(new Set(sources).size).toBe(1);
          expect(r.profile).toBe(sources[0]);
        }
        // A name supplied by the flag is always a valid profile name.
        if (flagged.length > 0) expect(r.profile).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
      }),
      { seed: 20261122, numRuns: 500 },
    );
  });
});
