import { PROFILE_NAME_RE } from "../shared/keychain.js";

/**
 * CLI wrapper for `check_permissions`. Loads the named profile, runs the
 * startup validation (including the capability probe when posture is
 * "detect"), and prints the permissions payload as JSON to stdout.
 *
 * Intended for operator use: inspecting what a profile can do without
 * spinning up a full MCP session.
 */
export async function runPermissions(profileArg?: string): Promise<void> {
  const profile = profileArg || process.env.CONFLUENCE_PROFILE;

  if (!profile) {
    console.error(
      "Usage: epimethian-mcp permissions <profile>\n" +
        "Or set CONFLUENCE_PROFILE in the environment."
    );
    process.exit(1);
  }

  if (!PROFILE_NAME_RE.test(profile)) {
    console.error(
      `Invalid profile name: "${profile}". Use lowercase alphanumeric and hyphens only (1-63 chars).`
    );
    process.exit(1);
  }

  // getConfig reads CONFLUENCE_PROFILE from the environment.
  process.env.CONFLUENCE_PROFILE = profile;

  const { getConfig, validateStartup } = await import(
    "../server/confluence-client.js"
  );
  const { buildCheckPermissionsPayload } = await import(
    "../server/check-permissions.js"
  );

  const config = await getConfig();
  // validateStartup runs the capability probe (when posture is "detect") and
  // updates the cached config with effectivePosture / probedCapability /
  // postureSource. Any auth failure there calls process.exit(1).
  await validateStartup(config);

  // Re-fetch the config to pick up the probe results populated by validateStartup.
  const resolved = await getConfig();
  const payload = buildCheckPermissionsPayload(resolved);
  console.log(JSON.stringify(payload, null, 2));
}
