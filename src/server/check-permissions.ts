import type { Config } from "./confluence-client.js";

export interface CheckPermissionsPayload {
  profile: string | null;
  user: { email: string };
  posture: {
    effective: "read-only" | "read-write";
    configured: "read-only" | "read-write" | "detect";
    source: "profile" | "probe" | "default";
  };
  tokenCapability: {
    authenticated: boolean;
    listSpaces: boolean;
    readPages: boolean;
    writePages: boolean | "unknown";
    addLabels: "unknown";
    setContentState: "unknown";
    addAttachments: "unknown";
    addComments: "unknown";
  };
  notes: string[];
}

/**
 * Build a `check_permissions` payload from the resolved Config.
 *
 * Values are derived entirely from Config fields populated by validateStartup()
 * (effectivePosture, probedCapability, postureSource, posture) plus static
 * fields that are always present (email, profile).
 *
 * listSpaces and readPages are always true: startup validation confirms auth
 * before the server starts. If validation failed the server is not running.
 *
 * Finer-grained fields (addLabels, setContentState, etc.) are "unknown" in v1.
 * Level 2a would populate them from a capability cache.
 */
export function buildCheckPermissionsPayload(config: Config): CheckPermissionsPayload {
  // Resolve effective posture — fall back to "read-write" when not populated
  // (pre-O1 test fixtures that don't set effectivePosture).
  const effective: "read-only" | "read-write" = config.effectivePosture ?? "read-write";

  // Resolve configured posture — fall back to effectivePosture when not set.
  const configured: "read-only" | "read-write" | "detect" =
    config.posture ?? config.effectivePosture ?? "read-write";

  // Resolve postureSource.
  const source: "profile" | "probe" | "default" = config.postureSource ?? "default";

  // Map probedCapability → writePages.
  //   "write"                      → true
  //   "read-only"                  → false
  //   "inconclusive" | null | undef → "unknown"
  let writePages: boolean | "unknown";
  if (config.probedCapability === "write") {
    writePages = true;
  } else if (config.probedCapability === "read-only") {
    writePages = false;
  } else {
    writePages = "unknown";
  }

  // Build the notes array.
  const notes: string[] = [];

  if (effective === "read-only" && writePages === true) {
    // User pinned to read-only but token has write access.
    notes.push(
      "This profile is pinned to read-only mode by user configuration. " +
      "The underlying token has write access, but write tools are not exposed to the agent."
    );
  } else if (effective === "read-only" && writePages === false) {
    // Both the profile and the token are read-only.
    notes.push("Both the profile and the token are read-only. Write tools are not exposed.");
  } else if (effective === "read-write" && writePages === false) {
    // Mismatch: profile wants write but token probe says read-only.
    notes.push(
      "WARNING: this profile is configured read-write but the token does not appear to have " +
      "write access. Writes will likely fail."
    );
  }

  return {
    profile: config.profile,
    user: { email: config.email },
    posture: {
      effective,
      configured,
      source,
    },
    tokenCapability: {
      authenticated: true,
      listSpaces: true,
      readPages: true,
      writePages,
      addLabels: "unknown",
      setContentState: "unknown",
      addAttachments: "unknown",
      addComments: "unknown",
    },
    notes,
  };
}
