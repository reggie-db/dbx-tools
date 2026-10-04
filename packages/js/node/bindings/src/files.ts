import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { AtomicWriteTextRequest, EnsureDirectoryRequest, ReadTextRequest } from "./types.ts";

/** Ensure a directory exists with the requested permissions. */
export async function ensureDirectory(request: EnsureDirectoryRequest): Promise<void> {
  const mode = request.mode ?? 0o700;
  await mkdir(request.path, { recursive: true, mode });
  if (request.mode !== undefined) await chmod(request.path, mode);
}

/** Read UTF-8 text and return the caller-provided missing-file value. */
export async function readTextFile(request: ReadTextRequest): Promise<string | undefined> {
  try {
    return await readFile(request.path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return request.defaultValue;
    throw cause;
  }
}

/** Atomically replace one UTF-8 file with the requested permissions. */
export async function atomicWriteTextFile(request: AtomicWriteTextRequest): Promise<void> {
  const mode = request.mode ?? 0o600;
  const parent = dirname(request.path);
  await ensureDirectory({ path: parent });
  const temporary = join(parent, `.${basename(request.path)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, request.content, {
      mode,
      flag: "wx",
    });
    await chmod(temporary, mode);
    await rename(temporary, request.path);
  } finally {
    await unlink(temporary).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
    });
  }
}
