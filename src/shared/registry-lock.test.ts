/**
 * 0-T12: the writer lock, stale handling, hand edits during a write and the
 * stale-temp sweep, with an injected clock, pid liveness and sleep.
 *
 * Real filesystem in a mkdtemp HOME. The fake clock starts at the real time
 * so file mtimes (set with utimes) compare meaningfully against it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, readdir, utimes, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addToProfileRegistry,
  setProfileSettings,
  getProfileRegistryLockPath,
  RegistryWriteRefusedError,
  REGISTRY_BUSY,
  REGISTRY_CHANGING,
  _setRegistryWriterEnvForTests,
  _resetForTests,
} from "./profiles.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;
const LOCK_MESSAGE =
  "Another epimethian-mcp command is changing the profile registry. Try again in a moment; nothing was changed.";

let home: string;
let configDir: string;
let registryPath: string;
let lockPath: string;
let clock: number;
let sleeps: number[];
let warnings: string[];
let alive: Set<number>;

function regText(r: unknown): string {
  return JSON.stringify(r, null, 2) + "\n";
}

async function current(): Promise<{ profiles: string[]; settings?: Record<string, unknown> }> {
  return JSON.parse(await readFile(registryPath, "utf-8"));
}

/** Set a file's mtime to `ms` on the fake clock's scale. */
async function age(path: string, ms: number): Promise<void> {
  const t = (clock - ms) / 1000;
  await utimes(path, t, t);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "registry-lock-"));
  await chmod(home, 0o700);
  configDir = join(home, ".config", "epimethian-mcp");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  registryPath = join(configDir, "profiles.json");
  vi.stubEnv("HOME", home);
  lockPath = getProfileRegistryLockPath();
  clock = Date.now();
  sleeps = [];
  warnings = [];
  alive = new Set([4242]);
  _setRegistryWriterEnvForTests({
    now: () => clock,
    pid: 4242,
    isPidAlive: (pid) => alive.has(pid),
    // Advance the fake clock; yield to real I/O briefly so another writer can progress.
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      await new Promise((r) => setTimeout(r, 2));
    },
    warn: (m) => warnings.push(m),
  });
  await writeFile(registryPath, regText({ profiles: ["start"] }), { mode: 0o600 });
});

afterEach(async () => {
  _resetForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

posixOnly("0-T12 lock", () => {
  it("the lock is the registry path + .lock and is gone after a write", async () => {
    expect(lockPath).toBe(`${registryPath}.lock`);
    await addToProfileRegistry("a");
    expect((await readdir(configDir)).sort()).toEqual(["profiles.json", "profiles.json.bak"]);
  });

  it("holds the writer's pid and an ISO time, mode 0600, while the write runs", async () => {
    let seen = "";
    let mode = 0;
    _setRegistryWriterEnvForTests({
      beforeCompare: async () => {
        seen = await readFile(lockPath, "utf-8");
        mode = (await lstat(lockPath)).mode & 0o777;
      },
    });
    await addToProfileRegistry("a");
    expect(seen).toBe(`4242\n${new Date(clock).toISOString()}\n`);
    expect(mode).toBe(0o600);
  });

  /** Concurrent writers share one fake clock; let real time pass instead so the 5 s limit is per writer. */
  function realtimeSleep(): void {
    _setRegistryWriterEnvForTests({
      sleep: async (ms) => {
        sleeps.push(ms);
        await new Promise((r) => setTimeout(r, 5));
      },
    });
  }

  it("two concurrent writers both land, one after the other", async () => {
    realtimeSleep();
    await Promise.all([addToProfileRegistry("one"), setProfileSettings("two", { readOnly: true })]);
    const r = await current();
    expect(r.profiles).toEqual(["start", "one"]);
    expect(r.settings).toEqual({ two: { readOnly: true } });
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms === 50)).toBe(true);
  });

  it("ten concurrent writers all land (no lost update)", async () => {
    realtimeSleep();
    const names = Array.from({ length: 10 }, (_, i) => `p${i}`);
    await Promise.all(names.map((n) => addToProfileRegistry(n)));
    expect([...(await current()).profiles].sort()).toEqual(["start", ...names].sort());
  });

  it("a held lock makes a writer refuse after 5 s with the lock message; bytes unchanged", async () => {
    await writeFile(lockPath, `4242\n${new Date(clock).toISOString()}\n`, { mode: 0o600 });
    const before = await readFile(registryPath);
    const err = await addToProfileRegistry("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryWriteRefusedError);
    expect(err).toMatchObject({ code: REGISTRY_BUSY, message: LOCK_MESSAGE });
    expect(sleeps).toHaveLength(100);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(5000);
    expect(await readFile(registryPath)).toEqual(before);
    // The other command's lock is left alone.
    expect(await readFile(lockPath, "utf-8")).toContain("4242");
    expect((await readdir(configDir)).sort()).toEqual(["profiles.json", "profiles.json.lock"]);
  });

  it("a lock older than 60 s with a dead pid is cleared with a warning, then the write lands", async () => {
    await writeFile(lockPath, `999\n2020-01-01T00:00:00.000Z\n`, { mode: 0o600 });
    await age(lockPath, 61_000);
    await addToProfileRegistry("x");
    expect((await current()).profiles).toEqual(["start", "x"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("stale lock");
    expect(warnings[0]).toContain("999");
    expect(sleeps).toEqual([]);
  });

  it("a lock older than 60 s whose pid is alive (also a reused pid) is never removed", async () => {
    alive.add(999);
    await writeFile(lockPath, `999\n2020-01-01T00:00:00.000Z\n`, { mode: 0o600 });
    await age(lockPath, 10 * 60_000);
    await expect(addToProfileRegistry("x")).rejects.toMatchObject({ code: REGISTRY_BUSY });
    expect(await readFile(lockPath, "utf-8")).toContain("999");
    expect(warnings).toEqual([]);
  });

  it("a lock younger than 60 s is kept even when its pid is dead", async () => {
    await writeFile(lockPath, `999\n`, { mode: 0o600 });
    // 50 s old: still under 60 s when the 5 s wait ends.
    await age(lockPath, 50_000);
    await expect(addToProfileRegistry("x")).rejects.toMatchObject({ code: REGISTRY_BUSY });
    expect(warnings).toEqual([]);
  });

  it("a lock that becomes stale during the wait is cleared then", async () => {
    await writeFile(lockPath, `999\n`, { mode: 0o600 });
    await age(lockPath, 58_000);
    await addToProfileRegistry("x");
    expect((await current()).profiles).toEqual(["start", "x"]);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.length).toBeLessThan(100);
  });

  it("an empty or unparseable stale lock (crash before the pid was written) is cleared", async () => {
    for (const content of ["", "not-a-pid\n", "0\n", "-5\n"]) {
      await writeFile(lockPath, content, { mode: 0o600 });
      await age(lockPath, 61_000);
      await addToProfileRegistry(`c${warnings.length}`);
    }
    expect(warnings).toHaveLength(4);
  });

  it("a symlink planted at the lock path is never followed; once stale it is removed, its target untouched", async () => {
    const target = join(home, "target.txt");
    await writeFile(target, "TARGET", { mode: 0o600 });
    await symlink(target, lockPath);
    const t = (clock - 61_000) / 1000;
    const { lutimes } = await import("node:fs/promises");
    await lutimes(lockPath, t, t);
    await addToProfileRegistry("x");
    expect(await readFile(target, "utf-8")).toBe("TARGET");
    expect((await current()).profiles).toEqual(["start", "x"]);
  });

  it("only its own lock is released: a lock replaced during the write stays", async () => {
    _setRegistryWriterEnvForTests({
      beforeCompare: async () => {
        await rm(lockPath);
        await writeFile(lockPath, "7777\n", { mode: 0o600 });
      },
    });
    await addToProfileRegistry("x");
    expect(await readFile(lockPath, "utf-8")).toBe("7777\n");
  });
});

posixOnly("0-T12 hand edit between read and rename", () => {
  it("is detected and the change is re-applied to the edited file", async () => {
    _setRegistryWriterEnvForTests({
      beforeCompare: async (attempt) => {
        if (attempt === 0) {
          await writeFile(registryPath, regText({ profiles: ["start", "hand"], settings: { hand: { readOnly: true } } }));
        }
      },
    });
    await addToProfileRegistry("cli");
    expect(await current()).toEqual({
      profiles: ["start", "hand", "cli"],
      settings: { hand: { readOnly: true } },
    });
    // .bak holds the version that was actually replaced: the hand edit.
    expect(JSON.parse(await readFile(`${registryPath}.bak`, "utf-8")).profiles).toEqual(["start", "hand"]);
    expect((await readdir(configDir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("an edit that replaces the file (rename, new inode) is detected too", async () => {
    _setRegistryWriterEnvForTests({
      beforeCompare: async (attempt) => {
        if (attempt !== 0) return;
        const tmp = join(configDir, "editor-swap");
        await writeFile(tmp, regText({ profiles: ["swapped"] }), { mode: 0o600 });
        const { rename } = await import("node:fs/promises");
        await rename(tmp, registryPath);
      },
    });
    await addToProfileRegistry("cli");
    expect((await current()).profiles).toEqual(["swapped", "cli"]);
  });

  it("an edit that makes the file unreadable stops the write with nothing changed", async () => {
    _setRegistryWriterEnvForTests({
      beforeCompare: async (attempt) => {
        if (attempt === 0) await writeFile(registryPath, `{"profiles": [`);
      },
    });
    await expect(addToProfileRegistry("cli")).rejects.toMatchObject({ code: "REGISTRY_UNREADABLE" });
    expect(await readFile(registryPath, "utf-8")).toBe(`{"profiles": [`);
    expect((await readdir(configDir)).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"))).toEqual([]);
  });

  it("a file that keeps changing is refused after three re-applies; the last edit stays", async () => {
    let attempts = 0;
    _setRegistryWriterEnvForTests({
      beforeCompare: async (attempt) => {
        attempts = attempt + 1;
        await writeFile(registryPath, regText({ profiles: [`edit-${attempt}`] }));
      },
    });
    const err = await addToProfileRegistry("cli").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryWriteRefusedError);
    expect(err).toMatchObject({ code: REGISTRY_CHANGING });
    expect((err as Error).message).toContain("nothing was changed");
    expect(attempts).toBe(4);
    expect((await current()).profiles).toEqual(["edit-3"]);
    expect((await readdir(configDir)).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"))).toEqual([]);
  });

  it("a registry created by hand while an absent-registry write runs is not overwritten", async () => {
    await rm(registryPath);
    _setRegistryWriterEnvForTests({
      beforeCompare: async (attempt) => {
        if (attempt === 0) await writeFile(registryPath, regText({ profiles: ["by-hand"] }), { mode: 0o600 });
      },
    });
    await addToProfileRegistry("cli");
    expect((await current()).profiles).toEqual(["by-hand", "cli"]);
  });
});

posixOnly("0-T12 stale-temp sweep", () => {
  it("removes our temp files older than one hour and keeps newer and foreign ones", async () => {
    const old16 = ".profiles.json.0123456789abcdef.tmp";
    const oldBak = ".profiles.json.bak.0123456789abcdef.tmp";
    const old760 = ".profiles.abcd1234.tmp";
    const fresh = ".profiles.json.fedcba9876543210.tmp";
    const foreign = [".update-check.json.0123456789abcdef.tmp", ".profiles.json.NOTHEX0000000000.tmp", "notes.tmp"];
    for (const name of [old16, oldBak, old760, fresh, ...foreign]) {
      await writeFile(join(configDir, name), "x", { mode: 0o600 });
    }
    for (const name of [old16, oldBak, old760, ...foreign]) await age(join(configDir, name), 2 * 60 * 60_000);
    await age(join(configDir, fresh), 59 * 60_000);
    // A directory with our name is not removed either.
    await mkdir(join(configDir, ".profiles.json.1111111111111111.tmp"));
    await age(join(configDir, ".profiles.json.1111111111111111.tmp"), 2 * 60 * 60_000);

    await addToProfileRegistry("x");

    const left = (await readdir(configDir)).sort();
    expect(left).not.toContain(old16);
    expect(left).not.toContain(oldBak);
    expect(left).not.toContain(old760);
    expect(left).toContain(fresh);
    for (const name of foreign) expect(left).toContain(name);
    expect(left).toContain(".profiles.json.1111111111111111.tmp");
  });

  it("an unsafe config directory is refused before the lock: nothing is swept", async () => {
    const old16 = ".profiles.json.0123456789abcdef.tmp";
    await writeFile(join(configDir, old16), "x", { mode: 0o600 });
    await age(join(configDir, old16), 2 * 60 * 60_000);
    await chmod(configDir, 0o770);
    await expect(addToProfileRegistry("x")).rejects.toMatchObject({ code: "REGISTRY_UNREADABLE" });
    await chmod(configDir, 0o700);
    expect(await readdir(configDir)).toContain(old16);
  });
});
