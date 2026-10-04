import { exec } from "@dbx-tools/core";
import { stringUtils } from "@dbx-tools/shared-core";

import type { ProcessRequest, ProcessResult } from "./types.ts";

/** Run one process through the shared Node execution helper. */
export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  const command = stringUtils.trimToNull(request.command);
  if (!command) throw new Error("Process command must not be empty");
  const controller = request.timeoutMs ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), request.timeoutMs) : undefined;
  try {
    const result = await exec.spawn(command, request.args ?? [], {
      cwd: request.cwd,
      env: request.env ? { ...process.env, ...request.env } : undefined,
      stdin: request.input ?? "ignore",
      stdout: "capture",
      stderr: "capture",
      signal: controller?.signal,
    });
    const stdout = stringUtils.trimToNull(result.stdout);
    const stderr = stringUtils.trimToNull(result.stderr);
    return {
      exitCode: result.exitCode,
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
