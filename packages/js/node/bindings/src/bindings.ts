import { atomicWriteJsonFile, ensureDirectory, readJsonFile, readTextFile } from "./files.ts";
import { executeHttp } from "./http.ts";
import { acquireFileLease, releaseFileLease } from "./locks.ts";
import { runProcess } from "./process.ts";
import type { JsBindings } from "./types.ts";

/** Default Node/Bun host bindings. */
export const nodeBindings: JsBindings = Object.freeze({
  runProcess,
  executeHttp,
  ensureDirectory,
  readTextFile,
  readJsonFile,
  atomicWriteJsonFile,
  acquireFileLease,
  releaseFileLease,
});
