import { describe, expect, it } from "vitest";
import { globalInstallPrefix, packageDirUnder } from "./install-location.js";

const SCRIPT = "node_modules/@de-otio/epimethian-mcp/dist/cli/index.js";

describe("globalInstallPrefix", () => {
  it("finds the prefix of a POSIX global install (Homebrew, nvm, /usr/local)", () => {
    expect(globalInstallPrefix(`/opt/homebrew/lib/${SCRIPT}`, "darwin")).toBe("/opt/homebrew");
    expect(globalInstallPrefix(`/Users/u/.nvm/versions/node/v22.1.0/lib/${SCRIPT}`, "darwin")).toBe(
      "/Users/u/.nvm/versions/node/v22.1.0"
    );
    expect(globalInstallPrefix(`/usr/local/lib/${SCRIPT}`, "linux")).toBe("/usr/local");
  });

  it("finds the prefix of a Windows global install", () => {
    expect(
      globalInstallPrefix(`C:\\Users\\u\\AppData\\Roaming\\npm\\${SCRIPT.replaceAll("/", "\\")}`, "win32")
    ).toBe("C:\\Users\\u\\AppData\\Roaming\\npm");
  });

  it("returns null for a copy that is not a global install", () => {
    // Source checkout.
    expect(globalInstallPrefix("/Users/u/repos/epimethian-mcp/dist/cli/index.js", "darwin")).toBeNull();
    // npx cache.
    expect(globalInstallPrefix(`/Users/u/.npm/_npx/0a1b2c/${SCRIPT}`, "darwin")).toBeNull();
    // A project's local node_modules.
    expect(globalInstallPrefix(`/Users/u/project/${SCRIPT}`, "darwin")).toBeNull();
    // Nested inside another global package's node_modules.
    expect(
      globalInstallPrefix(`/opt/homebrew/lib/node_modules/other/${SCRIPT}`, "darwin")
    ).toBeNull();
  });

  it("does not match a directory that only resembles the package name", () => {
    expect(
      globalInstallPrefix("/opt/homebrew/lib/node_modules/@de-otio/epimethian-mcp-fork/dist/cli/index.js", "darwin")
    ).toBeNull();
  });
});

describe("packageDirUnder", () => {
  it("is the inverse of globalInstallPrefix for the package directory", () => {
    expect(packageDirUnder("/opt/homebrew", "darwin")).toBe("/opt/homebrew/lib/node_modules/@de-otio/epimethian-mcp");
    expect(packageDirUnder("C:\\npm", "win32")).toBe("C:\\npm\\node_modules\\@de-otio\\epimethian-mcp");
  });
});
