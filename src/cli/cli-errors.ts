import {
  describeUnreadable,
  RegistryUnreadableError,
  RegistryWriteRefusedError,
} from "../shared/profiles.js";

/**
 * A command changed something (`done`) and a later step failed (`failed`).
 * Printed as is: the text says what changed, so it never claims "nothing was
 * changed". `failed` must not carry a raw error message from the keychain
 * tools (their messages can echo the command line, token included).
 */
export class PartialChangeError extends Error {
  constructor(
    readonly done: string,
    readonly failed: string,
    readonly next: string,
  ) {
    super(`${done}, but ${failed}.`);
    this.name = "PartialChangeError";
  }
}

/** A message for the person, printed as `Error: <message>` without a stack. */
export class CliMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliMessageError";
  }
}

/** errno-shaped code of an error, if any (never free text). */
function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z0-9]{1,20}$/.test(code) ? code : undefined;
}

/**
 * Pure. What failed in a registry write, as a clause for PartialChangeError
 * ("the profile registry could not be updated: ..."). Never file content.
 */
export function registryFailureText(err: unknown): string {
  if (err instanceof RegistryUnreadableError) {
    const { what, fix } = describeUnreadable(
      err.reason,
      err.path,
      null,
      err.backup !== undefined ? { path: err.backup, fitsAnchor: undefined } : undefined,
    );
    return `the profile registry could not be updated: ${what} (fix: ${fix})`;
  }
  if (err instanceof RegistryWriteRefusedError) return `the profile registry could not be updated: ${err.detail}`;
  const code = codeOf(err);
  return `the profile registry could not be updated${code ? ` (${code})` : ""}`;
}

/**
 * Pure. The text the CLI prints for an error the person can act on, or
 * undefined for an unexpected error (printed with its stack by the caller).
 * `RegistryUnreadableError` and `RegistryWriteRefusedError` come from a
 * preflight or a refused write that changed nothing; a command that had
 * already changed something reports a `PartialChangeError` instead.
 */
export function describeCliError(err: unknown): string | undefined {
  if (err instanceof RegistryUnreadableError) {
    const { what, fix } = describeUnreadable(
      err.reason,
      err.path,
      null,
      err.backup !== undefined ? { path: err.backup, fitsAnchor: undefined } : undefined,
    );
    return `Error: ${what.charAt(0).toUpperCase()}${what.slice(1)}; nothing was changed.\nFix: ${fix}`;
  }
  if (err instanceof RegistryWriteRefusedError) return `Error: ${err.message}`;
  if (err instanceof PartialChangeError) return `Error: ${err.message}\n${err.next}`;
  if (err instanceof CliMessageError) return `Error: ${err.message}`;
  return undefined;
}
