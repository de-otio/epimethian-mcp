import { describe, expect, it } from "vitest";
import { isValidAttachmentFilename } from "./filename-validator.js";

describe("isValidAttachmentFilename — legitimate filenames", () => {
  it("accepts simple names", () => {
    expect(isValidAttachmentFilename("image.png")).toBe(true);
    expect(isValidAttachmentFilename("report.pdf")).toBe(true);
    expect(isValidAttachmentFilename("notes.txt")).toBe(true);
  });

  it("accepts names with hyphens, underscores, spaces and parentheses", () => {
    expect(isValidAttachmentFilename("my-photo.jpg")).toBe(true);
    expect(isValidAttachmentFilename("my_photo.jpg")).toBe(true);
    expect(isValidAttachmentFilename("My Photo.jpg")).toBe(true);
    expect(isValidAttachmentFilename("photo (1).jpg")).toBe(true);
    expect(isValidAttachmentFilename("Report v2 (draft).docx")).toBe(true);
  });

  it("accepts multiple dots (not leading)", () => {
    expect(isValidAttachmentFilename("archive.tar.gz")).toBe(true);
    expect(isValidAttachmentFilename("v1.2.3.release.zip")).toBe(true);
  });

  it("accepts unicode filenames", () => {
    expect(isValidAttachmentFilename("日本語.pdf")).toBe(true);
    expect(isValidAttachmentFilename("café.txt")).toBe(true);
    expect(isValidAttachmentFilename("🐉.png")).toBe(true);
  });

  it("accepts a 255-char name", () => {
    const name = "a".repeat(251) + ".txt";
    expect(name.length).toBe(255);
    expect(isValidAttachmentFilename(name)).toBe(true);
  });
});

describe("isValidAttachmentFilename — path-traversal and separator rejection", () => {
  it("rejects `..`", () => {
    expect(isValidAttachmentFilename("..")).toBe(false);
  });

  it("rejects names starting with `.` (leading dot / hidden)", () => {
    expect(isValidAttachmentFilename(".hidden")).toBe(false);
    expect(isValidAttachmentFilename(".env")).toBe(false);
    expect(isValidAttachmentFilename(".")).toBe(false);
  });

  it("rejects names containing forward slashes", () => {
    expect(isValidAttachmentFilename("../etc/passwd")).toBe(false);
    expect(isValidAttachmentFilename("foo/bar.txt")).toBe(false);
    expect(isValidAttachmentFilename("/absolute.txt")).toBe(false);
  });

  it("rejects names containing backslashes", () => {
    expect(isValidAttachmentFilename("..\\windows\\system32")).toBe(false);
    expect(isValidAttachmentFilename("foo\\bar.txt")).toBe(false);
    expect(isValidAttachmentFilename("C:\\evil.exe")).toBe(false);
  });

  it("rejects percent-encoded traversal variants that still start with `..`", () => {
    // The leading-dot rule catches `..%2F...` even though the `%2F` is a
    // literal percent sequence rather than an actual slash.
    expect(isValidAttachmentFilename("..%2F..%2Fetc%2Fpasswd")).toBe(false);
  });

  it("accepts a filename beginning with `%2e` (literal percent, not a leading dot)", () => {
    // If an upstream layer decodes `%2e%2e%2fetc` before calling us, the
    // decoded form will have a leading `.` or a `/` and will be rejected.
    // The un-decoded form is just a weird literal filename — safe, and
    // neutralised by the downstream XML attribute escape.
    expect(isValidAttachmentFilename("%2e%2e%2fetc")).toBe(true);
  });
});

describe("isValidAttachmentFilename — control characters and null bytes", () => {
  it("rejects null bytes", () => {
    expect(isValidAttachmentFilename("foo\u0000.png")).toBe(false);
    expect(isValidAttachmentFilename("\u0000")).toBe(false);
  });

  it("rejects C0 control characters (tab, newline, etc.)", () => {
    expect(isValidAttachmentFilename("foo\tbar.png")).toBe(false);
    expect(isValidAttachmentFilename("foo\nbar.png")).toBe(false);
    expect(isValidAttachmentFilename("foo\rbar.png")).toBe(false);
    expect(isValidAttachmentFilename("foo\u001fbar.png")).toBe(false);
  });

  it("rejects C1 control characters (0x7F–0x9F)", () => {
    expect(isValidAttachmentFilename("foo\u007fbar.png")).toBe(false);
    expect(isValidAttachmentFilename("foo\u009fbar.png")).toBe(false);
  });
});

describe("isValidAttachmentFilename — boundary conditions", () => {
  it("rejects the empty string", () => {
    expect(isValidAttachmentFilename("")).toBe(false);
  });

  it("rejects oversized names (>255 chars)", () => {
    expect(isValidAttachmentFilename("a".repeat(256))).toBe(false);
    expect(isValidAttachmentFilename("a".repeat(1024))).toBe(false);
  });

  it("rejects non-string inputs defensively", () => {
    // @ts-expect-error -- intentional
    expect(isValidAttachmentFilename(null)).toBe(false);
    // @ts-expect-error -- intentional
    expect(isValidAttachmentFilename(undefined)).toBe(false);
    // @ts-expect-error -- intentional
    expect(isValidAttachmentFilename(42)).toBe(false);
  });
});
