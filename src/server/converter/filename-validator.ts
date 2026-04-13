/**
 * Attachment filename validation for Confluence ri:attachment refs.
 *
 * SECURITY: filenames flow into ri:filename XML attributes. Reject
 * path-traversal, control characters, and otherwise unsafe inputs.
 *
 * Stream 0: stub. Stream 1 implements.
 */

/**
 * Returns true if the filename is safe to emit into an ri:filename
 * attribute. Rejects: "..", "/", "\\", null bytes, control characters,
 * empty strings, leading dots.
 */
export function isValidAttachmentFilename(_name: string): boolean {
  throw new Error("isValidAttachmentFilename: not implemented (Stream 1)");
}
