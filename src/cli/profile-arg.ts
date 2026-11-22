import { PROFILE_NAME_RE } from "../shared/keychain.js";

/**
 * Which profile the server (default command) and `status` use.
 *
 * Setup prints client snippets with `"args": ["--profile", "<name>"]`, and the
 * environment can name one with `CONFLUENCE_PROFILE`. Both are honoured, but a
 * disagreement is an error: picking one silently could talk to another
 * company's tenant.
 *
 * Pure: reads only its arguments.
 *   - `argv` is the argument list after the executable and script
 *     (`process.argv.slice(2)`); `--profile <name>` and `--profile=<name>`
 *     are accepted, anywhere in it.
 *   - The flag's value is validated with PROFILE_NAME_RE. A missing value, or
 *     one starting with `-`, is an error. Repeating the flag with different
 *     values is an error.
 *   - An empty `CONFLUENCE_PROFILE` counts as unset (as in `getConfig`). When
 *     only the environment names a profile it is returned as is; the existing
 *     downstream check validates it with its own message.
 *
 * Result: `{ ok: true, profile }` with the single agreed name (or undefined
 * when neither names one), or `{ ok: false, error }`. Never a third value.
 */
export type ProfileResolution =
  | { readonly ok: true; readonly profile: string | undefined }
  | { readonly ok: false; readonly error: string };

const FLAG = "--profile";

export function resolveProfileArg(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): ProfileResolution {
  const fromFlags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let value: string | undefined;
    if (arg === FLAG) {
      value = argv[i + 1];
      i++; // the value is consumed (or absent)
    } else if (arg.startsWith(`${FLAG}=`)) {
      value = arg.slice(FLAG.length + 1);
    } else {
      continue;
    }
    if (value === undefined || value === "" || value.startsWith("-")) {
      return { ok: false, error: `${FLAG} needs a profile name (e.g. ${FLAG} acme).` };
    }
    if (!PROFILE_NAME_RE.test(value)) {
      return {
        ok: false,
        error: `Invalid profile name ${JSON.stringify(value)} given to ${FLAG}. Use lowercase alphanumeric and hyphens only (1-63 chars).`,
      };
    }
    fromFlags.push(value);
  }

  const distinct = [...new Set(fromFlags)];
  if (distinct.length > 1) {
    return {
      ok: false,
      error: `${FLAG} was given more than once with different names (${distinct.map((p) => JSON.stringify(p)).join(", ")}). Give it once.`,
    };
  }
  const flag = distinct[0];
  const fromEnv = env.CONFLUENCE_PROFILE || undefined;

  if (flag !== undefined && fromEnv !== undefined && flag !== fromEnv) {
    return {
      ok: false,
      error:
        `${FLAG} ${JSON.stringify(flag)} and CONFLUENCE_PROFILE=${JSON.stringify(fromEnv)} name different profiles. ` +
        `Refusing to start rather than pick one: remove one of them or make them agree.`,
    };
  }
  return { ok: true, profile: flag ?? fromEnv };
}
