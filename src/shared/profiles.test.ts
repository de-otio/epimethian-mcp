/**
 * Profile registry: three-state read, lookups, describeUnreadable, writers.
 *
 * Real filesystem: HOME points at a mkdtemp directory, so the registry lives
 * at <tmp>/.config/epimethian-mcp/profiles.json and every guard (O_NOFOLLOW,
 * fstat mode and owner, directory chain) runs against a real kernel.
 * Covers 0-T10 and the reader half of 0-D1; the writer core is in
 * registry-writer.test.ts (0-T2, 0-T3, 0-T9, 0-T11, 0-T12).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  readProfileRegistry,
  addToProfileRegistry,
  removeFromProfileRegistry,
  appendAuditLog,
  getProfileRegistryPath,
  getProfileRegistryBackupPath,
  getProfileSettings,
  setProfileSettings,
  readRegistry,
  registryFingerprint,
  sameObservation,
  parseRegistryText,
  profileSettingsOf,
  describeUnreadable,
  assertRegistryWritable,
  RegistryUnreadableError,
  REGISTRY_UNREADABLE,
  type UnreadableReason,
} from "./profiles.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

let home: string;
let configDir: string;
let registryPath: string;

async function writeRegistryText(text: string | Uint8Array): Promise<void> {
  await writeFile(registryPath, text, { mode: 0o600 });
}

async function writeRegistryJson(value: unknown): Promise<void> {
  await writeRegistryText(JSON.stringify(value, null, 2) + "\n");
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "profiles-test-"));
  await chmod(home, 0o700);
  configDir = join(home, ".config", "epimethian-mcp");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  registryPath = join(configDir, "profiles.json");
  vi.stubEnv("HOME", home);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await chmod(configDir, 0o700).catch(() => {});
  await rm(home, { recursive: true, force: true });
});

describe("paths", () => {
  it("are under HOME/.config/epimethian-mcp", () => {
    expect(getProfileRegistryPath()).toBe(registryPath);
    expect(getProfileRegistryBackupPath()).toBe(`${registryPath}.bak`);
  });
});

posixOnly("readRegistry (three states, 0-D1)", () => {
  it("absent: ENOENT only, with an 'absent' observation", async () => {
    const read = await readRegistry();
    expect(read).toEqual({ state: "absent", observed: "absent" });
  });

  it("absent also when the config directory does not exist yet", async () => {
    await rm(configDir, { recursive: true });
    expect((await readRegistry()).state).toBe("absent");
  });

  it("ok: profiles, settings, unknown top-level keys in extra, fingerprint of the fd", async () => {
    await writeRegistryJson({
      profiles: ["work"],
      settings: { work: { spaces: ["DEV"], futureKey: 1 } },
      version: 2,
      notes: { a: [1, 2] },
    });
    const read = await readRegistry();
    expect(read.state).toBe("ok");
    if (read.state !== "ok") return;
    expect(read.registry.profiles).toEqual(["work"]);
    expect(read.registry.settings).toEqual({ work: { spaces: ["DEV"], futureKey: 1 } });
    expect(read.registry.extra).toEqual({ version: 2, notes: { a: [1, 2] } });
    const st = await stat(registryPath, { bigint: true });
    expect(read.observed).toEqual({ ino: st.ino, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, size: st.size });
  });

  it("ok without settings has no settings key", async () => {
    await writeRegistryJson({ profiles: [] });
    const read = await readRegistry();
    expect(read.state === "ok" && "settings" in read.registry).toBe(false);
  });

  it.each([
    ["an array top level", "[]"],
    ["null", "null"],
    ["a number", "5"],
    ["profiles missing", "{}"],
    ["profiles not strings", `{"profiles":[1]}`],
    ["settings null", `{"profiles":[],"settings":null}`],
    ["settings an array", `{"profiles":[],"settings":[]}`],
    ["a settings entry not an object", `{"profiles":["a"],"settings":{"a":"read-only"}}`],
    ["a settings entry an array", `{"profiles":["a"],"settings":{"a":[]}}`],
  ])("unexpected-shape: %s", async (_label, text) => {
    await writeRegistryText(text);
    const read = await readRegistry();
    expect(read.state === "unreadable" && read.reason).toEqual({ kind: "unexpected-shape" });
  });

  it("parse-error: non-UTF-8 bytes have no position (strict decode)", async () => {
    await writeRegistryText(new Uint8Array([...Buffer.from(`{"profiles":["`), 0xc3, 0x28, ...Buffer.from(`"]}`)]));
    const read = await readRegistry();
    expect(read.state === "unreadable" && read.reason).toEqual({ kind: "parse-error" });
  });

  it("unreadable carries the path, the observation and .bak only when it exists", async () => {
    await writeRegistryText("{");
    let read = await readRegistry();
    expect(read).toMatchObject({ state: "unreadable", path: registryPath, backup: undefined });
    expect(read.observed).toMatchObject({ size: 1n });
    await writeFile(`${registryPath}.bak`, `{"profiles":[]}`, { mode: 0o600 });
    read = await readRegistry();
    expect(read).toMatchObject({ state: "unreadable", backup: `${registryPath}.bak` });
  });

  it("a .bak that is a directory or symlink is not offered", async () => {
    await writeRegistryText("{");
    await mkdir(`${registryPath}.bak`);
    expect(await readRegistry()).toMatchObject({ backup: undefined });
    await rm(`${registryPath}.bak`, { recursive: true });
    await symlink(registryPath, `${registryPath}.bak`);
    expect(await readRegistry()).toMatchObject({ backup: undefined });
  });

  it("io-error keeps only the errno (unreadable file mode 0000)", async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    await writeRegistryJson({ profiles: [] });
    await chmod(registryPath, 0o000);
    const read = await readRegistry();
    expect(read.state === "unreadable" && read.reason).toEqual({ kind: "io-error", errno: "EACCES" });
  });

  it("a symlinked config directory is unsafe-permissions/directory", async () => {
    const real = join(home, "real-config");
    await mkdir(real, { mode: 0o700 });
    await writeFile(join(real, "profiles.json"), `{"profiles":[]}`, { mode: 0o600 });
    await rm(configDir, { recursive: true });
    await symlink(real, configDir);
    const read = await readRegistry();
    expect(read.state === "unreadable" && read.reason).toEqual({
      kind: "unsafe-permissions",
      target: "directory",
      problem: "owner",
    });
  });
});

posixOnly("registryFingerprint", () => {
  it("absent, then the file's lstat, and a symlink is reported, not followed", async () => {
    expect(await registryFingerprint()).toBe("absent");
    await writeRegistryJson({ profiles: [] });
    const a = await registryFingerprint();
    const st = await stat(registryPath, { bigint: true });
    expect(a).toEqual({ ino: st.ino, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, size: st.size });
    await rm(registryPath);
    const target = join(home, "t.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, registryPath);
    const b = await registryFingerprint();
    expect(b).not.toBe("absent");
    expect(typeof b === "object" && "ino" in b && b.ino).not.toBe((await stat(target, { bigint: true })).ino);
  });

  it("other lstat failures keep the errno", async () => {
    // A path component that is a file: lstat fails with ENOTDIR.
    await rm(configDir, { recursive: true });
    await writeFile(configDir, "not a directory", { mode: 0o600 });
    expect(await registryFingerprint()).toEqual({ errno: "ENOTDIR" });
  });
});

describe("sameObservation", () => {
  const fp = { ino: 1n, mtimeNs: 2n, ctimeNs: 3n, size: 4n };
  it.each([
    ["absent/absent", "absent", "absent", true],
    ["absent/file", "absent", fp, false],
    ["file/same", fp, { ...fp }, true],
    ["file/other mtime", fp, { ...fp, mtimeNs: 5n }, false],
    ["file/other ctime", fp, { ...fp, ctimeNs: 5n }, false],
    ["file/other ino", fp, { ...fp, ino: 5n }, false],
    ["file/other size", fp, { ...fp, size: 5n }, false],
    ["errno/same", { errno: "EACCES" }, { errno: "EACCES" }, true],
    ["errno/other", { errno: "EACCES" }, { errno: "EIO" }, false],
    ["errno/file", { errno: "EACCES" }, fp, false],
  ] as const)("%s", (_l, a, b, expected) => {
    expect(sameObservation(a, b)).toBe(expected);
    expect(sameObservation(b, a)).toBe(expected);
  });
});

describe("parseRegistryText: parse-error position", () => {
  it("takes line and column from the error position (line 3, column 1)", () => {
    expect(parseRegistryText(`{\n  "profiles": [],\n}`)).toEqual({
      ok: false,
      reason: { kind: "parse-error", line: 3, column: 1 },
    });
  });

  it("first line: column is the 1-based offset", () => {
    expect(parseRegistryText(`{"profiles": [],}`)).toEqual({
      ok: false,
      reason: { kind: "parse-error", line: 1, column: 17 },
    });
  });

  it("older Node messages: 'at position N' is converted against the text, digits only", () => {
    const spy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw new SyntaxError("Unexpected token } in JSON at position 9");
    });
    expect(parseRegistryText(`{\n  "a":1,\n}`)).toEqual({ ok: false, reason: { kind: "parse-error", line: 2, column: 8 } });
    spy.mockImplementationOnce(() => {
      throw new SyntaxError("Unexpected end of JSON input at position 999");
    });
    expect(parseRegistryText("{")).toEqual({ ok: false, reason: { kind: "parse-error" } });
  });

  it("Node 20 messages quote the input; nothing of it is kept and there is no position", () => {
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw new SyntaxError(`Unexpected token '}', "{"secret":1,}" is not valid JSON`);
    });
    const r = parseRegistryText(`{"secret":1,}`);
    expect(r).toEqual({ ok: false, reason: { kind: "parse-error" } });
  });

  it("a non-Error throw is still a parse error without a position", () => {
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw "weird";
    });
    expect(parseRegistryText("x")).toEqual({ ok: false, reason: { kind: "parse-error" } });
  });

  it("no position for an empty text", () => {
    expect(parseRegistryText("")).toEqual({ ok: false, reason: { kind: "parse-error" } });
  });

  it("property: a parse-error reason holds only the kind and positive integers", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 200 }), (raw) => {
        const r = parseRegistryText(raw);
        if (r.ok || r.reason.kind !== "parse-error") return;
        expect(Object.keys(r.reason).sort()).toEqual(
          r.reason.line === undefined ? ["kind"] : ["column", "kind", "line"],
        );
        if (r.reason.line !== undefined) {
          expect(Number.isSafeInteger(r.reason.line) && r.reason.line >= 1).toBe(true);
          expect(Number.isSafeInteger(r.reason.column) && (r.reason.column ?? 0) >= 1).toBe(true);
          expect(r.reason.line).toBeLessThanOrEqual(raw.split("\n").length);
        }
      }),
    );
  });

  it("property: text around a canary in a broken registry never reaches the reason or the description", () => {
    const CANARY = "CANARY-p4r53-0xdead";
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        fc.constantFrom(`{"profiles": [`, `{"profiles": "`, `{"settings": {"`, `[`, `{`, `{"profiles":[], "x": `),
        (pre, post, opener) => {
          const raw = `${opener}${pre}${CANARY}${post}`;
          const r = parseRegistryText(raw);
          if (r.ok) return;
          const d = describeUnreadable(r.reason, registryPath, "work");
          expect(JSON.stringify(r.reason)).not.toContain(CANARY);
          expect(d.what + d.fix).not.toContain(CANARY);
          // Nothing of the user's text other than the template survives.
          for (const piece of [pre, post].filter((x) => x.length >= 6)) {
            expect(JSON.stringify(r.reason)).not.toContain(piece);
          }
        },
      ),
    );
  });
});

describe("parseRegistryText: unknown keys", () => {
  it("property: unknown top-level keys are kept in extra with equal values", () => {
    const key = fc.string({ minLength: 1, maxLength: 12 }).filter((k) => k !== "profiles" && k !== "settings");
    fc.assert(
      fc.property(fc.dictionary(key, fc.jsonValue()), (extra) => {
        const r = parseRegistryText(JSON.stringify({ profiles: ["a"], ...extra }));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.registry.extra).toEqual(JSON.parse(JSON.stringify(extra)));
      }),
    );
  });
});

posixOnly("lookups throw on unreadable and use own keys (0-T10)", () => {
  it("readProfileRegistry: [] when absent, the list when ok, throws when unreadable", async () => {
    expect(await readProfileRegistry()).toEqual([]);
    await writeRegistryJson({ profiles: ["globex", "acme"] });
    expect(await readProfileRegistry()).toEqual(["globex", "acme"]);
    await writeRegistryText("not-json{{{");
    await expect(readProfileRegistry()).rejects.toBeInstanceOf(RegistryUnreadableError);
  });

  it("getProfileSettings: undefined when absent or unknown, own entry when present, throws when unreadable", async () => {
    expect(await getProfileSettings("acme")).toBeUndefined();
    await writeRegistryJson({ profiles: ["acme"], settings: { acme: { readOnly: true } } });
    expect(await getProfileSettings("acme")).toEqual({ readOnly: true });
    expect(await getProfileSettings("unknown")).toBeUndefined();
    await writeRegistryJson({ profiles: "x" });
    const err = await getProfileSettings("acme").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryUnreadableError);
    expect(err).toMatchObject({ code: REGISTRY_UNREADABLE, reason: { kind: "unexpected-shape" }, path: registryPath });
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])(
    "a profile named %s is not found unless it is an own key",
    async (name) => {
      await writeRegistryJson({ profiles: ["work"], settings: { work: { readOnly: true } } });
      expect(await getProfileSettings(name)).toBeUndefined();
      // As an own key it is found (JSON.parse defines "__proto__" as an own property).
      await writeRegistryText(`{"profiles":["${name}"],"settings":{"${name}":{"posture":"read-only"}}}`);
      expect(await getProfileSettings(name)).toEqual({ posture: "read-only" });
    },
  );

  it("profileSettingsOf works on a read without touching the disk", () => {
    const ok = {
      state: "ok" as const,
      registry: { profiles: ["a"], settings: { a: { readOnly: true } }, extra: {} },
      observed: { ino: 1n, mtimeNs: 1n, ctimeNs: 1n, size: 1n },
    };
    expect(profileSettingsOf(ok, "a")).toEqual({ readOnly: true });
    expect(profileSettingsOf(ok, "constructor")).toBeUndefined();
    expect(profileSettingsOf({ state: "absent", observed: "absent" }, "a")).toBeUndefined();
    expect(() =>
      profileSettingsOf(
        { state: "unreadable", reason: { kind: "not-regular-file" }, path: "/x", backup: undefined, observed: "absent" },
        "a",
      ),
    ).toThrow(RegistryUnreadableError);
  });

  it("assertRegistryWritable passes when absent or ok and throws when unreadable", async () => {
    await expect(assertRegistryWritable()).resolves.toBeUndefined();
    await writeRegistryJson({ profiles: [] });
    await expect(assertRegistryWritable()).resolves.toBeUndefined();
    await chmod(registryPath, 0o622);
    await expect(assertRegistryWritable()).rejects.toMatchObject({
      reason: { kind: "unsafe-permissions", target: "file", problem: "mode" },
    });
  });
});

describe("describeUnreadable (fix table, step 0)", () => {
  const path = "/home/u/.config/epimethian-mcp/profiles.json";
  const cases: readonly [UnreadableReason, string, RegExp][] = [
    [{ kind: "parse-error", line: 14, column: 3 }, "near line 14, column 3", /^Fix the JSON near line 14, column 3 of .+profiles\.json, then run: epimethian-mcp profiles$/],
    [{ kind: "parse-error" }, "is not valid JSON", /^Fix the JSON in .+profiles\.json, then run: epimethian-mcp profiles$/],
    [{ kind: "unexpected-shape" }, "expected top level", /^Fix the top level of .+ \(\{"profiles": \[\.\.\.\], "settings": \{\.\.\.\}\}\), then run: epimethian-mcp profiles$/],
    [{ kind: "unsafe-permissions", target: "file", problem: "mode" }, "group- or world-writable", /^chmod 600 .+profiles\.json$/],
    [{ kind: "unsafe-permissions", target: "file", problem: "owner" }, "owned by another user", /^Replace .+ with a copy you own \(cp, then chmod 600\); it is owned by another user$/],
    [{ kind: "unsafe-permissions", target: "directory", problem: "mode" }, "directory", /^chmod 700 .+epimethian-mcp and make sure you own it and every directory above it/],
    [{ kind: "unsafe-permissions", target: "directory", problem: "owner" }, "symlink or owned", /^chmod 700 .+epimethian-mcp and make sure/],
    [{ kind: "not-regular-file" }, "not a regular file", /^Replace .+ with a regular file \(it is a symlink or not a file\)$/],
    [{ kind: "io-error", errno: "EACCES" }, "error EACCES", /^Check that you can read .+ \(error EACCES\)$/],
  ];

  it.each(cases)("%o", (reason, whatPart, fixRe) => {
    const d = describeUnreadable(reason, path, "work");
    expect(d.what).toContain(whatPart);
    expect(d.fix).toMatch(fixRe);
    expect(d.what).not.toMatch(/\n/);
    expect(d.fix).not.toMatch(/\n/);
  });

  it("names the file with ~ when it is under HOME", () => {
    vi.stubEnv("HOME", "/home/u");
    const d = describeUnreadable({ kind: "unsafe-permissions", target: "file", problem: "mode" }, path, null);
    expect(d.fix).toBe("chmod 600 ~/.config/epimethian-mcp/profiles.json");
    expect(d.what).toContain("~/.config/epimethian-mcp/profiles.json");
  });

  it("appends the .bak clause only when a backup is given; it is not called a good copy", () => {
    const without = describeUnreadable({ kind: "parse-error" }, path, "work");
    expect(without.fix).not.toContain(".bak");
    const withBak = describeUnreadable({ kind: "parse-error" }, path, "work", {
      path: `${path}.bak`,
      fitsAnchor: undefined,
    });
    expect(withBak.fix.startsWith(without.fix)).toBe(true);
    expect(withBak.fix).toContain("The version before the last CLI change is ");
    expect(withBak.fix).toContain("profiles.json.bak");
    expect(withBak.fix).not.toMatch(/last good|known good/i);
    expect(withBak.what).toBe(without.what);
  });

  it("never names a step-A command (policy)", () => {
    for (const [reason] of cases) {
      const d = describeUnreadable(reason, path, "work", { path: `${path}.bak`, fitsAnchor: undefined });
      expect(d.what + d.fix).not.toMatch(/epimethian-mcp policy/);
    }
  });
});

posixOnly("RegistryUnreadableError", () => {
  it("carries code, reason, path and backup, and its message has no file text", async () => {
    await writeRegistryText(`{"profiles": ["SECRET-TEXT-1234"`);
    const err = (await readProfileRegistry().catch((e: unknown) => e)) as RegistryUnreadableError;
    expect(err.code).toBe("REGISTRY_UNREADABLE");
    expect(err.name).toBe("RegistryUnreadableError");
    expect(err.message).not.toContain("SECRET-TEXT-1234");
    expect(err.backup).toBeUndefined();
  });
});

posixOnly("writers (behaviour kept from 7.6.0)", () => {
  it("addToProfileRegistry creates a 0600 file in a 0700 directory when absent", async () => {
    await rm(configDir, { recursive: true });
    await addToProfileRegistry("first-profile");
    expect(JSON.parse(await readFile(registryPath, "utf-8"))).toEqual({ profiles: ["first-profile"] });
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600);
    expect((await stat(configDir)).mode & 0o777).toBe(0o700);
  });

  it("addToProfileRegistry is idempotent and keeps settings", async () => {
    await writeRegistryJson({ profiles: ["existing"], settings: { existing: { readOnly: true } } });
    const before = await readFile(registryPath, "utf-8");
    await addToProfileRegistry("existing");
    expect(await readFile(registryPath, "utf-8")).toBe(before);
    await addToProfileRegistry("new-one");
    expect(JSON.parse(await readFile(registryPath, "utf-8"))).toEqual({
      profiles: ["existing", "new-one"],
      settings: { existing: { readOnly: true } },
    });
  });

  it("removeFromProfileRegistry removes the name and its settings; drops an empty settings object", async () => {
    await writeRegistryJson({
      profiles: ["keep", "remove-me"],
      settings: { "remove-me": { readOnly: true }, keep: { readOnly: false } },
    });
    await removeFromProfileRegistry("remove-me");
    expect(JSON.parse(await readFile(registryPath, "utf-8"))).toEqual({
      profiles: ["keep"],
      settings: { keep: { readOnly: false } },
    });
    await removeFromProfileRegistry("keep");
    expect(JSON.parse(await readFile(registryPath, "utf-8"))).toEqual({ profiles: [] });
  });

  it("removeFromProfileRegistry does nothing when the name is not listed", async () => {
    await writeRegistryJson({ profiles: ["other"] });
    const before = await readFile(registryPath, "utf-8");
    await removeFromProfileRegistry("not-here");
    expect(await readFile(registryPath, "utf-8")).toBe(before);
  });

  it("setProfileSettings merges shallowly and keeps other profiles", async () => {
    await writeRegistryJson({ profiles: ["acme", "globex"], settings: { globex: { readOnly: false }, acme: { readOnly: true, attribution: false } } });
    await setProfileSettings("acme", { readOnly: false });
    expect(JSON.parse(await readFile(registryPath, "utf-8"))).toEqual({
      profiles: ["acme", "globex"],
      settings: { globex: { readOnly: false }, acme: { readOnly: false, attribution: false } },
    });
  });
});

posixOnly("appendAuditLog", () => {
  it("appends a timestamped line to audit.log, 0600", async () => {
    await appendAuditLog('Removed profile "test"');
    const text = await readFile(join(configDir, "audit.log"), "utf-8");
    expect(text).toMatch(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\] Removed profile "test"\n$/);
    expect((await stat(join(configDir, "audit.log"))).mode & 0o777).toBe(0o600);
  });
});
