import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

vi.mock("../../install-agent.md", () => ({
  default: "# Epimethian MCP - Agent Installation Guide\n\n@de-otio/epimethian-mcp\n",
}));

describe("runAgentGuide", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the guide content to stdout", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const { runAgentGuide } = await import("./agent-guide.js");
    runAgentGuide();
    expect(writeSpy).toHaveBeenCalledOnce();
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).toContain("# Epimethian MCP - Agent Installation Guide");
  });
});

describe("agent guide: registry recovery mode", () => {
  // The suite mocks the guide import above; read the real file the CLI prints.
  it("tells the agent to relay REGISTRY_UNREADABLE and not to edit the file", async () => {
    const guide = await readFile(resolve(__dirname, "../../install-agent.md"), "utf-8");
    expect(guide).toContain("REGISTRY_UNREADABLE");
    expect(guide).toContain("setup_profile");
    expect(guide).toMatch(/Tell the user the message/);
    expect(guide).toMatch(/Do not edit, delete, replace, `chmod` or restore `profiles\.json`/);
  });
});
