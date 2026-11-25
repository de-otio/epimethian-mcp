import {
  describeUnreadable,
  RegistryUnreadableError,
  RegistryWriteRefusedError,
} from "../shared/profiles.js";

/**
 * Pure. The text the CLI prints for an error the person can act on, or
 * undefined for an unexpected error (printed with its stack by the caller).
 * `RegistryUnreadableError`: what is wrong and the fix line, never file
 * content. `RegistryWriteRefusedError`: its message (lock held, file kept
 * changing). Both say nothing was changed.
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
  return undefined;
}
