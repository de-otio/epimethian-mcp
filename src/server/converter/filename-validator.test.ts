import { describe, expect, it } from "vitest";
import { isValidAttachmentFilename } from "./filename-validator.js";

describe("filename-validator (Stream 0 stub)", () => {
  it("isValidAttachmentFilename is wired but not implemented", () => {
    expect(() => isValidAttachmentFilename("x")).toThrow("not implemented");
  });
});
