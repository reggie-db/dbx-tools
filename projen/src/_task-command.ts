/** Shared subprocess policy for Projen source and task entrypoints. */

import * as exec from "@dbx-tools/core/exec";

export interface TaskCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stderr?: "ignore" | "inherit";
}

export interface CaptureTaskCommandOptions extends TaskCommandOptions {
  /** Throw on a nonzero exit instead of returning an empty string. */
  readonly check?: boolean;
}

function executable(command: string): string {
  return command === "bun" && process.versions.bun ? process.execPath : command;
}

/** Run a non-interactive command with inherited output and checked exit status. */
export function runTaskCommand(
  cwd: string,
  command: string,
  args: readonly string[],
  options: TaskCommandOptions = {},
): void {
  exec.spawnSync(executable(command), [...args], {
    cwd,
    env: options.env,
    stdout: "inherit",
    stderr: options.stderr ?? "inherit",
    stdin: "ignore",
    check: true,
  });
}

/** Async counterpart used by timeout-bound and concurrently scheduled tasks. */
export async function runTaskCommandAsync(
  cwd: string,
  command: string,
  args: readonly string[],
  options: TaskCommandOptions & { readonly signal?: AbortSignal } = {},
): Promise<void> {
  await exec.spawn(executable(command), [...args], {
    cwd,
    env: options.env,
    stdout: "inherit",
    stderr: options.stderr ?? "inherit",
    stdin: "ignore",
    signal: options.signal,
    check: true,
  });
}

/** Capture trimmed stdout, optionally throwing when the command fails. */
export function captureTaskCommand(
  cwd: string,
  command: string,
  args: readonly string[],
  options: CaptureTaskCommandOptions = {},
): string {
  const result = exec.spawnSync(executable(command), [...args], {
    cwd,
    env: options.env,
    stdout: "capture",
    stderr: options.stderr ?? "ignore",
    stdin: "ignore",
    check: options.check ?? false,
  });
  return result.exitCode === 0 ? (result.stdout?.trim() ?? "") : "";
}

/** Run a command with inherited output and return whether it exited successfully. */
export function tryTaskCommand(
  cwd: string,
  command: string,
  args: readonly string[],
  options: TaskCommandOptions = {},
): boolean {
  return (
    exec.spawnSync(executable(command), [...args], {
      cwd,
      env: options.env,
      stdout: "inherit",
      stderr: options.stderr ?? "inherit",
      stdin: "ignore",
      check: false,
    }).exitCode === 0
  );
}

/** Whether a quiet, non-interactive command exits successfully. */
export function taskCommandSucceeds(
  cwd: string,
  command: string,
  args: readonly string[],
  options: Pick<TaskCommandOptions, "env"> = {},
): boolean {
  return (
    exec.spawnSync(executable(command), [...args], {
      cwd,
      env: options.env,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      check: false,
    }).exitCode === 0
  );
}
