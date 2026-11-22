import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { unavailableToolsFor } from "../server/api-capabilities.js";
import { GATEWAY_SCOPES } from "./gateway-scopes.js";

const DOC = readFileSync(resolve(__dirname, "../../doc/user-doc/installation.md"), "utf8");

describe("gateway scopes and the user documentation", () => {
  it("the read-write list is the read list plus the write scopes", () => {
    expect(GATEWAY_SCOPES["read-write"].slice(0, GATEWAY_SCOPES["read-only"].length)).toEqual(
      GATEWAY_SCOPES["read-only"],
    );
    expect(GATEWAY_SCOPES["read-only"].some((s) => /^(write|delete):/.test(s))).toBe(false);
  });

  it("installation.md lists every scope setup prints, and says they are unconfirmed", () => {
    for (const scope of GATEWAY_SCOPES["read-write"]) expect(DOC).toContain(`\`${scope}\``);
    expect(DOC).toContain("to be confirmed by the live probe");
  });

  it("installation.md's degradation table names every tool the gateway profile does not register", () => {
    for (const tool of unavailableToolsFor("gateway")) expect(DOC).toContain(`\`${tool}\``);
  });
});
