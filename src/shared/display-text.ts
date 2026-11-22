/**
 * Control characters (C0, DEL, C1) and bidi overrides. Tenant-supplied text
 * that is shown to the user (the tenant name at setup) must not be able to
 * rewrite the terminal line or reorder what is displayed.
 */
const DISPLAY_UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** Strip characters that could change how a tenant-supplied name is displayed. Pure. */
export function sanitizeDisplayName(name: string): string {
  return name.replace(DISPLAY_UNSAFE_RE, "").trim();
}
