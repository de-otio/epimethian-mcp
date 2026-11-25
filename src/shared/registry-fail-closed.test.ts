/**
 * 0-T1 (doc/design/policy-gate/06-deliverables.md, Step 0): an unreadable
 * profile registry fails closed.
 *
 * Reproduces analysis 02 "to verify": in 7.6.0 every read failure of
 * `profiles.json` (syntax error, wrong shape, unsafe mode, symlink, a
 * directory, another owner, an unsafe config directory) was treated as an
 * empty registry, so a profile with `spaces: ["DEV"]` and
 * `posture: "read-only"` silently came up with no settings and posture
 * "detect". After step 0 each case is `unreadable` with the right kind, the
 * settings lookup and `getConfig` throw, and a canary placed in the broken
 * file never appears in any reason, message, fix line or log line.
 *
 * Real filesystem in a mkdtemp HOME; the owner case mocks fstat's uid.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm, open } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANARY = "CANARY-c4n4ry-9f1e";

vi.mock("./keychain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./keychain.js")>();
  return {
    ...actual,
    readFromKeychain: vi.fn(async () => ({
      url: "https://example.atlassian.net",
      email: "user@example.com",
      apiToken: "token-not-a-secret",
    })),
  };
});

const posixOnly = process.platform === "win32" ? describe.skip : describe;

let home: string;
let configDir: string;
let registryPath: string;
let logged: string[];

/** The registry a person wrote: one restricted profile, plus the canary. */
function validRegistryText(): string {
  return JSON.stringify(
    {
      profiles: ["work"],
      settings: { work: { spaces: ["DEV"], posture: "read-only", note: CANARY } },
    },
    null,
    2,
  );
}

async function importProfiles() {
  vi.resetModules();
  return import("./profiles.js");
}

async function importClient() {
  vi.resetModules();
  return import("../server/confluence-client.js");
}

type Case = {
  readonly name: string;
  readonly arrange: () => Promise<void>;
  readonly kind: string;
  readonly extra?: Record<string, unknown>;
};

const CASES: readonly Case[] = [
  {
    name: "a trailing comma (syntax error with a position)",
    arrange: async () => {
      // The comma sits on line 3 of a three-line file; JSON.parse reports
      // the position of the closing brace that follows it.
      await writeFile(
        registryPath,
        `{\n  "profiles": ["work"], "settings": {"work": {"spaces": ["DEV"], "posture": "read-only", "note": "${CANARY}"}},\n}\n`,
        { mode: 0o600 },
      );
    },
    kind: "parse-error",
    extra: { line: 3, column: 1 },
  },
  {
    name: "an empty file (syntax error without a position)",
    arrange: async () => {
      await writeFile(registryPath, "", { mode: 0o600 });
    },
    kind: "parse-error",
  },
  {
    name: "mode 0666",
    arrange: async () => {
      await writeFile(registryPath, validRegistryText(), { mode: 0o600 });
      await chmod(registryPath, 0o666);
    },
    kind: "unsafe-permissions",
    extra: { target: "file", problem: "mode" },
  },
  {
    name: "a symlink",
    arrange: async () => {
      const real = join(home, "elsewhere.json");
      await writeFile(real, validRegistryText(), { mode: 0o600 });
      await symlink(real, registryPath);
    },
    kind: "not-regular-file",
  },
  {
    name: '{"profiles": "x"}',
    arrange: async () => {
      await writeFile(registryPath, JSON.stringify({ profiles: "x", note: CANARY }), { mode: 0o600 });
    },
    kind: "unexpected-shape",
  },
  {
    name: "a directory",
    arrange: async () => {
      await mkdir(registryPath, { mode: 0o700 });
      await writeFile(join(registryPath, CANARY), CANARY, { mode: 0o600 });
    },
    kind: "not-regular-file",
  },
  {
    name: "a file owned by another uid (fstat mocked)",
    arrange: async () => {
      await writeFile(registryPath, validRegistryText(), { mode: 0o600 });
      await mockFstatUidOffset(registryPath);
    },
    kind: "unsafe-permissions",
    extra: { target: "file", problem: "owner" },
  },
  {
    name: "a group-writable config directory",
    arrange: async () => {
      await writeFile(registryPath, validRegistryText(), { mode: 0o600 });
      await chmod(configDir, 0o770);
    },
    kind: "unsafe-permissions",
    extra: { target: "directory", problem: "mode" },
  },
];

/** Make fstat of the registry's fd report another owner (all other fds untouched). */
async function mockFstatUidOffset(path: string): Promise<void> {
  const probe = await open(path, "r");
  const proto = Object.getPrototypeOf(probe) as { stat: (...a: unknown[]) => Promise<unknown> };
  await probe.close();
  const original = proto.stat;
  const target = realpathSync(path);
  vi.spyOn(proto, "stat").mockImplementation(async function (this: { fd: number }, ...args: unknown[]) {
    const st = (await original.apply(this, args)) as Record<string, unknown> & { uid: number | bigint; ino: number | bigint };
    const targetIno = (await import("node:fs")).statSync(target, { bigint: true }).ino;
    if (BigInt(st.ino as bigint) !== targetIno) return st;
    const copy = Object.create(Object.getPrototypeOf(st));
    Object.assign(copy, st, { uid: typeof st.uid === "bigint" ? st.uid + 1n : (st.uid as number) + 1 });
    return copy;
  });
}

function expectNoCanary(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(text).not.toContain(CANARY);
}

posixOnly("0-T1 registry fails closed", () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "registry-fail-closed-"));
    await chmod(home, 0o700);
    configDir = join(home, ".config", "epimethian-mcp");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    registryPath = join(configDir, "profiles.json");
    vi.stubEnv("HOME", home);
    vi.stubEnv("CONFLUENCE_PROFILE", "work");
    logged = [];
    for (const method of ["error", "warn", "log", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await chmod(configDir, 0o700).catch(() => {});
    await rm(home, { recursive: true, force: true });
  });

  for (const c of CASES) {
    describe(c.name, () => {
      it.fails("readRegistry reports unreadable with the right kind, and no canary", async () => {
        await c.arrange();
        const { readRegistry, describeUnreadable } = await importProfiles();
        const read = await readRegistry();
        expect(read.state).toBe("unreadable");
        if (read.state !== "unreadable") return;
        expect(read.reason.kind).toBe(c.kind);
        if (c.extra) expect(read.reason).toMatchObject(c.extra);
        if (c.kind === "parse-error" && !c.extra) {
          expect(read.reason).not.toHaveProperty("line");
          expect(read.reason).not.toHaveProperty("column");
        }
        expect(read.path).toBe(registryPath);
        const { what, fix } = describeUnreadable(read.reason, read.path, "work");
        expectNoCanary(read);
        expectNoCanary(what);
        expectNoCanary(fix);
        expectNoCanary(logged);
      });

      it.fails("getProfileSettings throws RegistryUnreadableError (7.6.0: undefined)", async () => {
        await c.arrange();
        const { getProfileSettings, RegistryUnreadableError } = await importProfiles();
        const err = await getProfileSettings("work").then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(RegistryUnreadableError);
        expect((err as InstanceType<typeof RegistryUnreadableError>).reason.kind).toBe(c.kind);
        expectNoCanary((err as Error).message);
        expectNoCanary(logged);
      });

      it.fails("getConfig throws instead of starting with posture detect (7.6.0: detect)", async () => {
        await c.arrange();
        const { getConfig } = await importClient();
        const { RegistryUnreadableError } = await import("./profiles.js");
        const outcome = await getConfig().then(
          (config) => ({ config }),
          (error: unknown) => ({ error }),
        );
        expect(outcome).toHaveProperty("error");
        expect((outcome as { error: unknown }).error).toBeInstanceOf(RegistryUnreadableError);
        expectNoCanary(logged);
      });
    });
  }

  it.fails("absent stays absent: no settings, no throw", async () => {
    const { readRegistry, getProfileSettings, readProfileRegistry } = await importProfiles();
    const read = await readRegistry();
    expect(read.state).toBe("absent");
    expect(await getProfileSettings("work")).toBeUndefined();
    expect(await readProfileRegistry()).toEqual([]);
  });

  it("a readable registry still yields the profile's settings", async () => {
    await writeFile(registryPath, validRegistryText(), { mode: 0o600 });
    const { getProfileSettings } = await importProfiles();
    expect(await getProfileSettings("work")).toMatchObject({ spaces: ["DEV"], posture: "read-only" });
  });
});
