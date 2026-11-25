import { describe, it, expect } from "vitest";
import { describeCliError } from "./cli-errors.js";
import {
  RegistryUnreadableError,
  RegistryWriteRefusedError,
  REGISTRY_CHANGING,
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
