#!/usr/bin/env node
// Live v1/v2 parity probe for the Confluence REST APIs (release 7.6.0, W-INV).
//
// OPT-IN. A person runs this by hand against the designated test profile.
// It is never run in CI and no test loads real credentials.
//
//   node scripts/live/v2-parity.mjs --profile <name> --pages <id,id,...> \
//        [--blogposts <id,id>] [--versions 6] [--gateway [--scopes a,b]] [--delay-ms 400]
//
// GET/HEAD only (enforced in v2-parity-lib.mjs), sequential, paced, and
// refuses to plan or run more than 150 requests. Prints counts, statuses and
// hashes as a Markdown table on stdout; never bodies, titles, names, space keys
// or hosts. Progress and the request total go to stderr.
//
// --gateway needs a profile whose keychain record is a scoped-token record
// (apiMode "gateway") with a sealed cloudId; the gateway base is built from
// that cloudId only. Without --gateway the profile must be a site-mode record.

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  PROFILE_NAME_RE,
  REQUEST_CAP,
  UsageError,
  allocateVersions,
  createRecorder,
  createRequester,
  parseCliArgs,
  planRequests,
  renderReport,
  runProbe,
  VERSION_CAP,
} from "./v2-parity-lib.mjs";

const SERVICE = "epimethian-mcp";
const CLOUD_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => (err ? reject(new Error("keychain read failed")) : resolve(stdout)));
  });
}

/** Same keychain layout as src/shared/keychain.ts (service epimethian-mcp, account confluence-credentials/<profile>). */
async function loadCredentials(profile) {
  if (!PROFILE_NAME_RE.test(profile)) throw new UsageError("invalid profile name");
  const account = `confluence-credentials/${profile}`;
  let raw;
  if (process.platform === "darwin") {
    raw = await exec("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
  } else if (process.platform === "linux") {
    raw = await exec("secret-tool", ["lookup", "service", SERVICE, "account", account]);
  } else {
    throw new UsageError(`keychain not supported on ${process.platform}`);
  }
  const p = JSON.parse(raw.trim());
  if (typeof p?.url !== "string" || typeof p?.email !== "string" || typeof p?.apiToken !== "string") {
    throw new UsageError("the keychain record is missing url, email or apiToken");
  }
  return {
    url: p.url,
    email: p.email,
    apiToken: p.apiToken,
    cloudId: typeof p.cloudId === "string" ? p.cloudId : undefined,
    apiMode: p.apiMode === "gateway" ? "gateway" : "site",
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const itemCount = args.pages.length + args.blogposts.length;
  const versionsTotal = allocateVersions(itemCount, args.versions, VERSION_CAP).reduce((a, b) => a + b, 0);
  const planned = planRequests({ itemCount, versionsTotal, mode: args.mode });
  if (planned > REQUEST_CAP) {
    throw new UsageError(`this run could need ${planned} requests; the limit is ${REQUEST_CAP}. Use fewer ids or --versions.`);
  }

  const creds = await loadCredentials(args.profile);
  let origin;
  if (args.mode === "gateway") {
    if (creds.apiMode !== "gateway") throw new UsageError("--gateway needs a profile that holds a scoped (gateway-mode) token");
    if (!creds.cloudId || !CLOUD_ID_RE.test(creds.cloudId)) throw new UsageError("gateway mode needs a sealed cloudId on the profile");
    origin = `https://api.atlassian.com/ex/confluence/${creds.cloudId}`;
  } else {
    if (creds.apiMode === "gateway") throw new UsageError("this profile holds a scoped token; run with --gateway");
    const site = new URL(creds.url);
    if (site.protocol !== "https:") throw new UsageError("the profile URL must be https");
    origin = site.origin;
  }

  const requester = createRequester({
    fetchImpl: fetch,
    authorization: `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64")}`,
    credentialedPrefixes: [`${origin}/`],
    maxRequests: REQUEST_CAP,
    delayMs: args.delayMs,
  });

  console.error(`mode=${args.mode} items=${itemCount} versions<=${versionsTotal} planned-max-requests=${planned} cap=${REQUEST_CAP}`);
  const recorder = await runProbe({
    request: requester.request,
    mode: args.mode,
    origin,
    pages: args.pages,
    blogposts: args.blogposts,
    versionsPerId: args.versions,
    recorder: createRecorder(),
  });

  process.stdout.write(
    renderReport(recorder, {
      mode: args.mode,
      date: new Date().toISOString().slice(0, 10),
      requests: requester.count(),
      cap: REQUEST_CAP,
      scopes: args.scopes,
    }) + "\n"
  );
  console.error(`requests sent: ${requester.count()}`);
  if (recorder.state.aborted) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Messages are fixed strings; they never carry URLs or response content.
    console.error(err instanceof UsageError ? `error: ${err.message}` : `error: ${err?.name ?? "failure"}`);
    process.exitCode = 1;
  });
}
