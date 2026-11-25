import { describe, it, expect } from "vitest";
import { describeCliError, PartialChangeError, CliMessageError, registryFailureText } from "./cli-errors.js";
import {
  RegistryUnreadableError,
  RegistryWriteRefusedError,
  REGISTRY_CHANGING,
  REGISTRY_BUSY,
} from "../shared/profiles.js";

describe("describeCliError", () => {
  it("an unreadable registry: capitalised what, nothing changed, fix line", () => {
    const text = describeCliError(new RegistryUnreadableError({ kind: "parse-error", line: 3, column: 7 }, "/x/profiles.json"));
    expect(text).toBe(
      "Error: The profile registry /x/profiles.json has a JSON syntax error near line 3, column 7; nothing was changed.\n" +
        "Fix: Fix the JSON near line 3, column 7 of /x/profiles.json, then run: epimethian-mcp profiles",
    );
  });

  it("names the .bak when the error carries one", () => {
    const text = describeCliError(
      new RegistryUnreadableError({ kind: "not-regular-file" }, "/x/profiles.json", "/x/profiles.json.bak"),
    );
    expect(text).toContain("The version before the last CLI change is /x/profiles.json.bak");
  });

  it("a refused write prints its message", () => {
    expect(describeCliError(new RegistryWriteRefusedError(REGISTRY_CHANGING, "kept changing"))).toBe("Error: kept changing");
  });

  it("anything else is not described", () => {
    expect(describeCliError(new Error("x"))).toBeUndefined();
    expect(describeCliError("x")).toBeUndefined();
  });
});

describe("partial changes", () => {
  it("PartialChangeError prints what changed, what failed and the next step", () => {
    expect(describeCliError(new PartialChangeError("A happened", "B failed", "Do C."))).toBe(
      "Error: A happened, but B failed.\nDo C.",
    );
  });

  it("CliMessageError prints its message", () => {
    expect(describeCliError(new CliMessageError("plain"))).toBe("Error: plain");
  });

  it("registryFailureText never says nothing was changed", () => {
    const texts = [
      registryFailureText(new RegistryUnreadableError({ kind: "parse-error" }, "/x/profiles.json")),
      registryFailureText(new RegistryWriteRefusedError(REGISTRY_BUSY, "busy; nothing was changed", "another command")),
      registryFailureText(Object.assign(new Error("disk full: SECRET"), { code: "ENOSPC" })),
      registryFailureText(new Error("free text SECRET")),
    ];
    for (const t of texts) {
      expect(t).toMatch(/^the profile registry could not be updated/);
      expect(t).not.toContain("nothing was changed");
      expect(t).not.toContain("SECRET");
    }
    expect(texts[0]).toContain("fix: Fix the JSON in /x/profiles.json");
    expect(texts[2]).toContain("ENOSPC");
  });
});
