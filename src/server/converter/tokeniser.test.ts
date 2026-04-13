import { describe, expect, it } from "vitest";
import { tokeniseStorage } from "./tokeniser.js";

describe("tokeniser (Stream 0 stub)", () => {
  it("tokeniseStorage is wired but not implemented", () => {
    expect(() => tokeniseStorage("<p>x</p>")).toThrow("not implemented");
  });
});
