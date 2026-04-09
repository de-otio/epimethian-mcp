import { describe, it, expect, vi, beforeEach } from "vitest";

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
