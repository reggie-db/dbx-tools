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

export type ProbeTaskCommandOptions = TaskCommandOptions;

export interface LoggedTaskCommandOptions extends TaskCommandOptions {
  /** Receive normalized stdout and stderr lines after the command exits. */
  readonly onLine: (line: string) => void;
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

/** Capture trimmed stdout while preserving command failure as `undefined`. */
export function probeTaskCommand(
  cwd: string,
  command: string,
  args: readonly string[],
  options: ProbeTaskCommandOptions = {},
): string | undefined {
  const result = exec.spawnSync(executable(command), [...args], {
    cwd,
    env: options.env,
    stdout: "capture",
    stderr: options.stderr ?? "ignore",
    stdin: "ignore",
    check: false,
  });
  return result.exitCode === 0 ? (result.stdout?.trim() ?? "") : undefined;
}

/** Run a checked command while routing captured output through one line policy. */
export function runLoggedTaskCommand(
  cwd: string,
  command: string,
  args: readonly string[],
  options: LoggedTaskCommandOptions,
): void {
  const result = exec.spawnSync(executable(command), [...args], {
    cwd,
    env: options.env,
    stdout: "capture",
    stderr: "capture",
    stdin: "ignore",
    check: false,
  });
  for (const line of [...result.stdoutLines, ...result.stderrLines]) {
    if (line) options.onLine(line);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${command} exited with ${result.exitCode}`);
  }
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

/** Run Git with the shared non-interactive checked command policy. */
export function runGitTaskCommand(
  cwd: string,
  args: readonly string[],
  options: TaskCommandOptions = {},
): void {
  runTaskCommand(cwd, "git", args, options);
}

/** Capture Git output, returning an empty string for optional offline probes. */
export function captureGitTaskCommand(
  cwd: string,
  args: readonly string[],
  options: CaptureTaskCommandOptions = {},
): string {
  return captureTaskCommand(cwd, "git", args, options);
}

/** Whether a quiet Git command succeeds. */
export function gitTaskCommandSucceeds(
  cwd: string,
  args: readonly string[],
  options: Pick<TaskCommandOptions, "env"> = {},
): boolean {
  return taskCommandSucceeds(cwd, "git", args, options);
}
