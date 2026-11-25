/**
 * The registry writer core (doc/design/policy-gate/02-interfaces.md §1.1):
 * 0-T2 (refuse on unreadable), 0-T3 (property: invalid file, no byte
 * changes), 0-T9 (updateProfileSettings), 0-T11 (durability, writer half).
 * Lock and races (0-T12) are in registry-lock.test.ts.
 *
 * Real filesystem in a mkdtemp HOME. "Unchanged" is checked on a snapshot of
 * the whole config directory: every entry's type, mode and bytes (or link
 * target), so a stray temp, lock or .bak write also counts as a change.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
  stat,
  lstat,
  symlink,
  readdir,
  readlink,
  open,
} from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  addToProfileRegistry,
  removeFromProfileRegistry,
  setProfileSettings,
  updateProfileSettings,
  writeWithAnchor,
  registerProfile,
  readRegistry,
  serializeRegistry,
  RegistryUnreadableError,
  _resetForTests,
  type ProfileSettings,
  type Registry,
} from "./profiles.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;
const CANARY = "CANARY-wr1t3r-77aa";

let home: string;
let configDir: string;
let registryPath: string;
let bakPath: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "registry-writer-"));
  await chmod(home, 0o700);
  configDir = join(home, ".config", "epimethian-mcp");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  registryPath = join(configDir, "profiles.json");
  bakPath = `${registryPath}.bak`;
  vi.stubEnv("HOME", home);
  _resetForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetForTests();
  await chmod(configDir, 0o700).catch(() => {});
  await chmod(registryPath, 0o700).catch(() => {}); // cleanup only (may be a directory)
  await rm(home, { recursive: true, force: true });
});

type Entry = { readonly kind: string; readonly mode: number; readonly content: string };

/** Every entry under the config directory (recursively), plus the directory's own mode. */
async function snapshot(): Promise<Record<string, Entry>> {
  const out: Record<string, Entry> = {};
  out["."] = { kind: "dir", mode: (await lstat(configDir)).mode & 0o7777, content: "" };
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const st = await lstat(path);
      const key = prefix + name;
      if (st.isSymbolicLink()) {
        out[key] = { kind: "link", mode: 0, content: await readlink(path) };
      } else if (st.isDirectory()) {
        out[key] = { kind: "dir", mode: st.mode & 0o7777, content: "" };
        await walk(path, `${key}/`);
      } else {
        const mode = st.mode & 0o7777;
        // Read even a 0000 file: chmod for the read, then put the mode back.
        if ((mode & 0o400) === 0) await chmod(path, 0o600);
        const bytes = (await readFile(path)).toString("base64");
        if ((mode & 0o400) === 0) await chmod(path, mode);
        out[key] = { kind: "file", mode, content: bytes };
      }
    }
  }
  await walk(configDir, "");
  return out;
}

function regText(r: unknown): string {
  return JSON.stringify(r, null, 2) + "\n";
}

const VALID = {
  profiles: ["work", "home"],
  settings: { work: { spaces: ["DEV"], posture: "read-only", note: CANARY }, home: { readOnly: false } },
  extraTop: { keep: true },
};

/** Make fstat of the registry's inode report another owner. */
async function mockRegistryOwnerElsewhere(): Promise<void> {
  const probe = await open(registryPath, "r");
  const proto = Object.getPrototypeOf(probe) as { stat: (...a: unknown[]) => Promise<unknown> };
  await probe.close();
  const original = proto.stat;
  const ino = (await stat(registryPath, { bigint: true })).ino;
  vi.spyOn(proto, "stat").mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const st = (await original.apply(this, args)) as { ino: number | bigint; uid: number | bigint };
    if (BigInt(st.ino) !== ino) return st;
    const uid = typeof st.uid === "bigint" ? st.uid + 1n : st.uid + 1;
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid });
  });
}

const UNREADABLE: readonly (readonly [string, string, () => Promise<void>])[] = [
  ["parse-error", "parse-error", async () => writeFile(registryPath, `{"profiles": ["work"], "note": "${CANARY}"`, { mode: 0o600 })],
  ["unexpected-shape", "unexpected-shape", async () => writeFile(registryPath, regText({ profiles: "x", note: CANARY }), { mode: 0o600 })],
  ["file mode 0666", "unsafe-permissions", async () => {
    await writeFile(registryPath, regText(VALID), { mode: 0o600 });
    await chmod(registryPath, 0o666);
  }],
  ["file owned by another uid", "unsafe-permissions", async () => {
    await writeFile(registryPath, regText(VALID), { mode: 0o600 });
    await mockRegistryOwnerElsewhere();
  }],
  ["group-writable config directory", "unsafe-permissions", async () => {
    await writeFile(registryPath, regText(VALID), { mode: 0o600 });
    await chmod(configDir, 0o770);
  }],
  ["symlink", "not-regular-file", async () => {
    const real = join(home, "real.json");
    await writeFile(real, regText(VALID), { mode: 0o600 });
    await symlink(real, registryPath);
  }],
  ["directory", "not-regular-file", async () => {
    await mkdir(registryPath, { mode: 0o700 });
    await writeFile(join(registryPath, "inside"), CANARY, { mode: 0o600 });
  }],
  ["io-error (mode 0000)", "io-error", async () => {
    await writeFile(registryPath, regText(VALID), { mode: 0o600 });
    await chmod(registryPath, 0o000);
  }],
];

const WRITERS: readonly (readonly [string, () => Promise<unknown>])[] = [
  ["addToProfileRegistry", () => addToProfileRegistry("added")],
  ["removeFromProfileRegistry", () => removeFromProfileRegistry("work")],
  ["setProfileSettings", () => setProfileSettings("work", { readOnly: true })],
  ["updateProfileSettings", () => updateProfileSettings("work", () => undefined)],
  ["writeWithAnchor", () => writeWithAnchor((r) => ({ ...(r ?? { profiles: [], extra: {} }), profiles: ["x"] }), { kind: "other" })],
  ["registerProfile", () => registerProfile("added", { posture: "read-only" })],
];

posixOnly("0-T2 every writer refuses on every unreadable kind; nothing changes", () => {
  const isRoot = process.getuid?.() === 0;
  for (const [label, kind, arrange] of UNREADABLE) {
    for (const [writer, run] of WRITERS) {
      it(`${writer} × ${label}`, async () => {
        if (isRoot && kind === "io-error") return;
        await writeFile(bakPath, regText({ profiles: ["older"] }), { mode: 0o600 });
        await arrange();
        const before = await snapshot();
        const err = await run().then(() => undefined, (e: unknown) => e);
        expect(err).toBeInstanceOf(RegistryUnreadableError);
        expect((err as RegistryUnreadableError).reason.kind).toBe(kind);
        expect((err as Error).message).not.toContain(CANARY);
        expect(await snapshot()).toEqual(before);
        const names = Object.keys(await snapshot());
        expect(names.filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"))).toEqual([]);
      });
    }
  }

  it("absent: addToProfileRegistry creates a 0600 file; an existing .bak is byte-identical", async () => {
    await writeFile(bakPath, `{"profiles": ["only-copy-of-something"]}  \n`, { mode: 0o600 });
    const bakBefore = await readFile(bakPath);
    await addToProfileRegistry("first");
    expect(JSON.parse(await readFile(registryPath, "utf-8"))).toEqual({ profiles: ["first"] });
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(bakPath)).toEqual(bakBefore);
    expect((await readdir(configDir)).sort()).toEqual(["profiles.json", "profiles.json.bak"]);
  });

  it("absent: removeFromProfileRegistry and a no-op update create nothing", async () => {
    await removeFromProfileRegistry("nobody");
    await updateProfileSettings("nobody", () => undefined);
    expect(await readdir(configDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 0-T3: property over invalidating mutations of a valid registry.
// ---------------------------------------------------------------------------

const nameArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/);
const settingsArb: fc.Arbitrary<ProfileSettings> = fc.record(
  {
    posture: fc.constantFrom("read-only" as const, "read-write" as const, "detect" as const),
    spaces: fc.array(fc.constantFrom("HR", "DEV", "DOCS"), { maxLength: 3 }),
    attribution: fc.boolean(),
  },
  { requiredKeys: [] },
);
const validRegistryArb = fc
  .uniqueArray(nameArb, { maxLength: 4 })
  .chain((profiles) =>
    fc.record({
      profiles: fc.constant(profiles),
      settings: fc.option(
        fc.dictionary(fc.constantFrom(...(profiles.length ? profiles : ["solo"])), settingsArb),
        { nil: undefined },
      ),
      extra: fc.option(fc.jsonValue(), { nil: undefined }),
    }),
  )
  .map(({ profiles, settings, extra }) => ({
    profiles,
    ...(settings !== undefined ? { settings } : {}),
    ...(extra !== undefined ? { extra } : {}),
  }));

type Mutation = (text: string) => Uint8Array;
const enc = (s: string) => new TextEncoder().encode(s);

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.constant<Mutation>((t) => enc(t.replace("{", ""))),
  fc.constant<Mutation>((t) => enc(t.slice(0, t.lastIndexOf("}")))),
  fc.constantFrom<unknown>("x", 5, {}, null, [1]).map<Mutation>((bad) => (t) =>
    enc(JSON.stringify({ ...JSON.parse(t), profiles: bad }))),
  fc.constantFrom<unknown>("x", [], null, 5).map<Mutation>((bad) => (t) =>
    enc(JSON.stringify({ ...JSON.parse(t), settings: bad }))),
  fc.constantFrom<unknown>("x", 5, [], null).map<Mutation>((bad) => (t) =>
    enc(JSON.stringify({ ...JSON.parse(t), settings: { someone: bad } }))),
  fc.nat().map<Mutation>((n) => (t) => enc(t.slice(0, n % Math.max(1, t.length - 1)))),
  fc.tuple(fc.nat(), fc.constantFrom([0xff], [0xc3, 0x28], [0x80], [0xed, 0xa0, 0x80])).map<Mutation>(
    ([n, bytes]) => (t) => {
      const b = enc(t);
      const at = n % (b.length + 1);
      return new Uint8Array([...b.subarray(0, at), ...bytes, ...b.subarray(at)]);
    },
  ),
);

posixOnly("0-T3 property: an invalid registry is never changed by any CLI write", () => {
  it("holds for dropped braces, wrong types, truncation and non-UTF-8 bytes", async () => {
    await fc.assert(
      fc.asyncProperty(validRegistryArb, mutationArb, fc.integer({ min: 0, max: WRITERS.length - 1 }), async (valid, mutate, w) => {
        await rm(configDir, { recursive: true, force: true });
        await mkdir(configDir, { mode: 0o700 });
        await writeFile(registryPath, mutate(regText(valid)), { mode: 0o600 });
        const read = await readRegistry();
        fc.pre(read.state === "unreadable");
        const before = await snapshot();
        const err = await WRITERS[w]![1]().then(() => undefined, (e: unknown) => e);
        expect(err).toBeInstanceOf(RegistryUnreadableError);
        expect(await snapshot()).toEqual(before);
      }),
      { numRuns: 60 },
    );
  });
});

// ---------------------------------------------------------------------------
// 0-T9 updateProfileSettings.
// ---------------------------------------------------------------------------

posixOnly("0-T9 updateProfileSettings", () => {
  const start = {
    profiles: ["a", "b", "c"],
    settings: {
      a: { posture: "read-only", spaces: ["HR"] },
      b: { readOnly: true, policy: { read_budget: { pages: 5, window_minutes: 60 }, other: [1] }, attribution: false },
      c: { spaces: ["DOCS"], nested: { deep: { keep: "me" } } },
    },
    topLevelUnknown: { v: 1 },
  };

  beforeEach(async () => {
    await writeFile(registryPath, regText(start), { mode: 0o600 });
  });

  async function current(): Promise<typeof start> {
    return JSON.parse(await readFile(registryPath, "utf-8"));
  }

  it("removes a key and returns before/after", async () => {
    const result = await updateProfileSettings("b", (prev) => {
      const { readOnly: _drop, ...rest } = prev ?? {};
      return rest;
    });
    expect(result.before).toEqual(start.settings.b);
    expect(result.after).toEqual({ policy: start.settings.b.policy, attribution: false });
    expect((await current()).settings.b).toEqual(result.after);
  });

  it("replaces the policy block whole (no deep merge)", async () => {
    const result = await updateProfileSettings("b", (prev) => ({ ...prev, policy: { only: true } }) as ProfileSettings);
    expect((await current()).settings.b).toEqual({ readOnly: true, policy: { only: true }, attribution: false });
    expect(result.after).toEqual({ readOnly: true, policy: { only: true }, attribution: false });
  });

  it("removes the profile's entry when fn returns undefined; others' subtrees and key order are equal", async () => {
    const result = await updateProfileSettings("b", () => undefined);
    expect(result).toEqual({ before: start.settings.b, after: undefined });
    const now = await current();
    expect(Object.keys(now.settings)).toEqual(["a", "c"]);
    expect(now.settings.a).toEqual(start.settings.a);
    expect(now.settings.c).toEqual(start.settings.c);
    expect(now.profiles).toEqual(start.profiles);
    expect(now.topLevelUnknown).toEqual(start.topLevelUnknown);
  });

  it("keeps the entry's position when it is replaced and appends a new one", async () => {
    await updateProfileSettings("a", () => ({ readOnly: true }));
    expect(Object.keys((await current()).settings)).toEqual(["a", "b", "c"]);
    await updateProfileSettings("d", () => ({ readOnly: true }));
    expect(Object.keys((await current()).settings)).toEqual(["a", "b", "c", "d"]);
  });

  it("drops the settings object when its last entry is removed", async () => {
    for (const name of ["a", "b", "c"]) await updateProfileSettings(name, () => undefined);
    expect(await current()).toEqual({ profiles: start.profiles, topLevelUnknown: start.topLevelUnknown });
  });

  it("returning prev writes nothing (same inode, same bytes, no .bak)", async () => {
    const st = await stat(registryPath, { bigint: true });
    const result = await updateProfileSettings("a", (prev) => prev);
    expect(result.before).toBe(result.after);
    expect((await stat(registryPath, { bigint: true })).ino).toBe(st.ino);
    expect((await readdir(configDir)).sort()).toEqual(["profiles.json"]);
  });

  it("an own-key-only lookup: a profile named constructor starts from undefined", async () => {
    const seen: unknown[] = [];
    await updateProfileSettings("constructor", (prev) => {
      seen.push(prev);
      return { readOnly: true };
    });
    expect(seen).toEqual([undefined]);
    expect((await current()).settings).toHaveProperty("constructor", { readOnly: true });
  });

  it("property: for any update of one profile, every other profile's subtree is unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("a", "b", "c", "z"), fc.option(settingsArb, { nil: undefined }), async (name, value) => {
        await writeFile(registryPath, regText(start), { mode: 0o600 });
        await updateProfileSettings(name, () => value);
        const now = (await current()) as { settings?: Record<string, unknown> };
        for (const other of ["a", "b", "c"].filter((n) => n !== name)) {
          expect(now.settings?.[other]).toEqual(start.settings[other as "a"]);
        }
        expect(now.settings?.[name]).toEqual(value);
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// 0-T11 durability, writer half.
// ---------------------------------------------------------------------------

posixOnly("0-T11 durability (writer core)", () => {
  it(".bak holds the exact bytes of the readable file before the write, 0600", async () => {
    // Unusual but valid formatting: the bytes, not a re-serialisation, go to .bak.
    const original = `{ "profiles" : [ "work" ] ,\t"settings": {"work": {"readOnly": true}}, "zz": 1.50 }`;
    await writeFile(registryPath, original, { mode: 0o600 });
    await addToProfileRegistry("second");
    expect(await readFile(bakPath, "utf-8")).toBe(original);
    expect((await stat(bakPath)).mode & 0o777).toBe(0o600);
    // The next write moves the backup one step forward.
    const afterFirst = await readFile(registryPath, "utf-8");
    await addToProfileRegistry("third");
    expect(await readFile(bakPath, "utf-8")).toBe(afterFirst);
  });

  it(".bak is fsynced and renamed before the registry's temp is written", async () => {
    const proto = Object.getPrototypeOf(await (async () => {
      const fh = await open(join(home, "probe"), "w");
      await fh.close();
      return fh;
    })()) as { sync: (...a: unknown[]) => Promise<void> };
    const fdPaths = new Map<number, string>();
    const realOpen = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof realOpen>) => {
      const fh = await realOpen(...args);
      fdPaths.set(fh.fd, String(args[0]));
      return fh;
    });
    const events: string[] = [];
    const realSync = proto.sync;
    vi.spyOn(proto, "sync").mockImplementation(async function (this: { fd: number }) {
      const p = fdPaths.get(this.fd) ?? "?";
      events.push(`sync ${p.replace(configDir, "").replace(/[0-9a-f]{16}/, "X")}`);
      return realSync.call(this);
    });
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (a, b) => {
      events.push(`rename ${String(b).replace(configDir, "")}`);
      return realRename(a, b);
    });
    await writeFile(registryPath, regText({ profiles: ["a"] }), { mode: 0o600 });
    await addToProfileRegistry("b");
    expect(events).toEqual([
      "sync /.profiles.json.bak.X.tmp",
      "rename /profiles.json.bak",
      "sync ",
      "sync /.profiles.json.X.tmp",
      "rename /profiles.json",
      "sync ",
    ]);
  });

  it("unknown top-level and per-profile keys survive every writer", async () => {
    const original = {
      profiles: ["work"],
      settings: { work: { readOnly: true, futureSetting: { x: [1, "two"] } } },
      schemaVersion: 3,
      "__proto__": { stays: "a key" },
      notes: null,
    };
    // JSON.stringify drops an own __proto__ key written as a literal; build the text by hand.
    const text = `{"profiles":["work"],"settings":{"work":{"readOnly":true,"futureSetting":{"x":[1,"two"]}}},"schemaVersion":3,"__proto__":{"stays":"a key"},"notes":null}`;
    void original;
    await writeFile(registryPath, text, { mode: 0o600 });
    await addToProfileRegistry("home");
    await setProfileSettings("work", { attribution: false });
    await updateProfileSettings("home", () => ({ posture: "read-only" }));
    await removeFromProfileRegistry("home");
    const after = await readFile(registryPath, "utf-8");
    const parsed = JSON.parse(after);
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.notes).toBeNull();
    expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value).toEqual({ stays: "a key" });
    expect(parsed.settings.work).toEqual({ readOnly: true, futureSetting: { x: [1, "two"] }, attribution: false });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it("a fault-injected rename failure leaves the registry intact, no temp and no lock", async () => {
    await writeFile(registryPath, regText({ profiles: ["a"] }), { mode: 0o600 });
    const original = await readFile(registryPath);
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (a, b) => {
      if (String(b) === registryPath) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
      return realRename(a, b);
    });
    await expect(addToProfileRegistry("b")).rejects.toThrow("injected EIO");
    expect(await readFile(registryPath)).toEqual(original);
    // .bak was written first and holds the same (complete, readable) bytes.
    expect(await readFile(bakPath)).toEqual(original);
    expect((await readdir(configDir)).sort()).toEqual(["profiles.json", "profiles.json.bak"]);
  });

  it("a .bak write failure aborts before the registry is touched", async () => {
    await writeFile(registryPath, regText({ profiles: ["a"] }), { mode: 0o600 });
    const original = await readFile(registryPath);
    await mkdir(bakPath); // rename onto a directory fails
    await writeFile(join(bakPath, "x"), "x");
    await expect(addToProfileRegistry("b")).rejects.toThrow();
    expect(await readFile(registryPath)).toEqual(original);
    expect((await readdir(configDir)).sort()).toEqual(["profiles.json", "profiles.json.bak"]);
  });

  it("a change function that throws writes nothing and releases the lock", async () => {
    await writeFile(registryPath, regText({ profiles: ["a"] }), { mode: 0o600 });
    const before = await snapshot();
    await expect(
      writeWithAnchor(() => {
        throw new Error("boom");
      }, { kind: "other" }),
    ).rejects.toThrow("boom");
    expect(await snapshot()).toEqual(before);
  });

  it("a change that would produce an unreadable registry is refused before writing", async () => {
    await writeFile(registryPath, regText({ profiles: ["a"] }), { mode: 0o600 });
    const before = await snapshot();
    await expect(
      writeWithAnchor(() => ({ profiles: [1 as unknown as string], extra: {} }), { kind: "other" }),
    ).rejects.toThrow(/would be unreadable/);
    expect(await snapshot()).toEqual(before);
  });

  it("writeWithAnchor returns before and after; returning prev is a no-op", async () => {
    await writeFile(registryPath, regText({ profiles: ["a"] }), { mode: 0o600 });
    const r1 = await writeWithAnchor((prev) => ({ ...(prev as Registry), profiles: ["a", "b"] }), { kind: "other" });
    expect(r1.before?.profiles).toEqual(["a"]);
    expect(r1.after.profiles).toEqual(["a", "b"]);
    const st = await stat(registryPath, { bigint: true });
    const r2 = await writeWithAnchor((prev) => prev as Registry, { kind: "other" });
    expect(r2.after).toBe(r2.before);
    expect((await stat(registryPath, { bigint: true })).ino).toBe(st.ino);
  });

  it("serializeRegistry orders profiles, settings, then unknown keys, and parses back", () => {
    const text = serializeRegistry({ profiles: ["a"], settings: { a: { readOnly: true } }, extra: { z: 1, b: [2] } });
    expect(Object.keys(JSON.parse(text))).toEqual(["profiles", "settings", "z", "b"]);
    expect(text.endsWith("}\n")).toBe(true);
  });
});

posixOnly("registerProfile (setup: name and settings in one write)", () => {
  it("adds the name and its settings in a single write (one rename)", async () => {
    await writeFile(registryPath, regText({ profiles: ["a"] }), { mode: 0o600 });
    const renames: string[] = [];
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (a, b) => {
      renames.push(String(b));
      return realRename(a, b);
    });
    await registerProfile("b", { posture: "read-only" });
    expect(renames.filter((r) => r === registryPath)).toHaveLength(1);
    expect(JSON.parse(await readFile(registryPath, "utf-8"))).toEqual({
      profiles: ["a", "b"],
      settings: { b: { posture: "read-only" } },
    });
  });

  it("re-running on an existing profile merges: other settings kept, name not duplicated", async () => {
    await writeFile(
      registryPath,
      regText({ profiles: ["a"], settings: { a: { posture: "read-write", spaces: ["DEV"], attribution: false } } }),
      { mode: 0o600 },
    );
    await registerProfile("a", { posture: "read-only" });
    expect(JSON.parse(await readFile(registryPath, "utf-8"))).toEqual({
      profiles: ["a"],
      settings: { a: { posture: "read-only", spaces: ["DEV"], attribution: false } },
    });
  });

  it("creates the registry when absent", async () => {
    await registerProfile("first", { posture: "detect" });
    expect(JSON.parse(await readFile(registryPath, "utf-8"))).toEqual({
      profiles: ["first"],
      settings: { first: { posture: "detect" } },
    });
  });
});
