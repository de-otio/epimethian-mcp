import guideContent from "../../install-agent.md";

export function runAgentGuide(): void {
  process.stdout.write(guideContent);
}
