/**
 * Read a local file that a tool is about to upload to Confluence.
 *
 * An upload copies local bytes to anyone who can read the page, so a coerced
 * agent asking to "attach .env" is an exfiltration channel. The rules:
 *   - the real path (symlinks resolved) must be under the working directory;
 *   - no dot-directory or dot-file on the way (.env, .git/config,
 *     .claude/settings.json), mirroring `download_attachment`;
 *   - the file is opened with O_NOFOLLOW and checked through the open handle
 *     (`fstat`), so a swap between the check and the read cannot substitute
 *     another file at the final component;
 *   - a regular file of at most MAX_UPLOAD_BYTES, read from that handle.
 */

import { open, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { findDotSegment } from "../shared/safe-fs.js";

/** Same ceiling as a download: one call must not move unbounded data. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const O_NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;

export class UploadPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadPathError";
  }
}

export interface UploadFile {
  /** The resolved real path that was read. */
  path: string;
  data: Buffer;
}

export async function readUploadFile(filePath: string): Promise<UploadFile> {
  let resolved: string;
  try {
    resolved = await realpath(resolve(filePath));
  } catch {
    throw new UploadPathError(`File not found: ${filePath}`);
  }
  const cwd = await realpath(process.cwd());
  if (!resolved.startsWith(cwd + "/")) {
    throw new UploadPathError(
      `File path must be under the working directory (${cwd}). Got: ${resolved}`
    );
  }
  const dotSegment = findDotSegment(resolved, cwd);
  if (dotSegment !== undefined) {
    throw new UploadPathError(
      `Refusing to upload from a dot-directory or a dot-file ` +
        `(found "${dotSegment.slice(0, 64)}"): these hold configuration and secrets. ` +
        `Copy the file elsewhere under the working directory if it really should be shared.`
    );
  }

  let handle;
  try {
    handle = await open(resolved, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ELOOP") {
      throw new UploadPathError(`Refusing to read through a symlink at ${resolved}.`);
    }
    throw err;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      throw new UploadPathError(`Not a regular file: ${resolved}`);
    }
    if (st.size > MAX_UPLOAD_BYTES) {
      throw new UploadPathError(
        `File is ${st.size} bytes, above the ${MAX_UPLOAD_BYTES}-byte upload limit.`
      );
    }
    // Read at most one byte past the limit, so a file that grows after the
    // fstat is still refused rather than read whole.
    const buf = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_UPLOAD_BYTES) {
        throw new UploadPathError(
          `File grew past the ${MAX_UPLOAD_BYTES}-byte upload limit while being read.`
        );
      }
    }
    // Copy out so the oversized scratch buffer is not kept alive.
    return { path: resolved, data: Buffer.from(buf.subarray(0, total)) };
  } finally {
    await handle.close();
  }
}
