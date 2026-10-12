#!/usr/bin/env -S bun
/** Restart a development command after relevant workspace changes settle. */
import { isAbsolute, relative, resolve } from "node:path";
import { serializeArgs } from "@dbx-tools/cli-args";
import * as exec from "@dbx-tools/core/exec";
import { watch as pathWatch } from "@dbx-tools/path";
import { errorUtils, log } from "@dbx-tools/shared-core";
import { CommanderError } from "commander";
import { z } from "zod";
import { parsedTaskOptions, runTaskMain, taskCommand, taskPositionals } from "./cli.ts";
import { DEV_RESTART_DEBOUNCE_MS, DEV_RESTART_KEY, DEV_WATCH_TASK } from "../src/dev-watch.ts";
import {
  readPackageManifest,
  recordedPackages,
  resolveRepoRoot,
  workspaceDependencyDirectories,
} from "../src/packages.ts";

const logger = log.logger("projen:dev-watch");
const SHUTDOWN_TIMEOUT_MS = 2_000;

export const DevWatchOptionsSchema = z.object({
  debounceMs: z.coerce
    .number()
    .int()
    .nonnegative("Debounce must be a non-negative number of milliseconds")
    .default(DEV_RESTART_DEBOUNCE_MS)
    .describe("Quiet period before restarting the command"),
  restartKey: z
    .string()
    .refine((value) => Array.from(value).length === 1, "Restart key must be exactly one character")
    .default(DEV_RESTART_KEY)
    .describe("Interactive immediate-restart key"),
  watchInclude: z
    .array(z.string())
    .default([])
    .describe("Glob patterns to watch; replaces the default workspace-package directories")
    .meta({ env: "DEV_WATCH_INCLUDE", short: "i" }),
  watchExclude: z
    .array(z.string())
    .default([])
    .describe("Glob patterns to ignore after the include set is chosen")
    .meta({ env: "DEV_WATCH_EXCLUDE", short: "e" }),
});

/** Parsed watcher flags plus the pass-through command argv. */
export type DevWatchOptions = z.output<typeof DevWatchOptionsSchema> & {
  readonly command: readonly string[];
};

interface WorkspacePackage {
  readonly dir: string;
  readonly name?: string;
}

/** Parse watcher flags while passing every token after the command through unchanged. */
export function parseDevWatchOptions(args: readonly string[]): DevWatchOptions {
  const program = taskCommand(
    import.meta.url,
    "Restart a development command after watched changes settle",
    DevWatchOptionsSchema,
  )
    .name(DEV_WATCH_TASK)
    .exitOverride()
    .configureOutput({
      writeErr: (message) => {
        if (process.argv[1]) process.stderr.write(message);
      },
    })
    .enablePositionalOptions()
    .passThroughOptions()
    .argument("<command>")
    .argument("[args...]")
    .parse([...args], { from: "user" });
  const options = parsedTaskOptions(program, DevWatchOptionsSchema);
  const [command, commandArgs = []] = taskPositionals(program) as [string, string[]?];
  return {
    ...options,
    command: [command, ...commandArgs],
  };
}

/**
 * Parse `--watch-include` / `--watch-exclude` from argv that may contain unrelated
 * tokens (the root demo forwards only these flags into `dev:watch`).
 */
export function parseWatchGlobOptions(
  args: readonly string[],
): Pick<DevWatchOptions, "watchInclude" | "watchExclude"> {
  const program = taskCommand(
    import.meta.url,
    "Restart a development command after watched changes settle",
    DevWatchOptionsSchema,
  )
    .name(DEV_WATCH_TASK)
    .exitOverride()
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .parse([...args], { from: "user" });
  const options = parsedTaskOptions(program, DevWatchOptionsSchema);
  return {
    watchInclude: options.watchInclude,
    watchExclude: options.watchExclude,
  };
}

/** Serialize include/exclude globs as Commander flags for a nested `dev:watch`. */
export function serializedWatchGlobArgs(
  options: Pick<DevWatchOptions, "watchInclude" | "watchExclude">,
): string[] {
  return serializeArgs({
    watchInclude: options.watchInclude,
    watchExclude: options.watchExclude,
  });
}

function containsPath(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function workspacePackages(root: string): WorkspacePackage[] {
  return recordedPackages(root)
    .map(({ dir }) => {
      const name = readPackageManifest(dir)?.name;
      return { dir, name: typeof name === "string" ? name : undefined };
    })
    .sort((left, right) => right.dir.length - left.dir.length);
}

function optionArgument(
  command: readonly string[],
  longName: string,
  shortName?: string,
): string | undefined {
  for (let index = 0; index < command.length; index++) {
    const token = command[index]!;
    if (token === longName || (shortName !== undefined && token === shortName)) {
      return command[index + 1];
    }
    if (token.startsWith(`${longName}=`)) return token.slice(longName.length + 1);
    if (shortName !== undefined && token.startsWith(`${shortName}=`)) {
      return token.slice(shortName.length + 1);
    }
  }
  return undefined;
}

function commandWorkingDirectory(command: readonly string[], cwd: string): string {
  const configured = optionArgument(command, "--cwd");
  return configured ? resolve(cwd, configured) : cwd;
}

function commandPackage(
  command: readonly string[],
  cwd: string,
  packages: readonly WorkspacePackage[],
): WorkspacePackage | undefined {
  const selected = optionArgument(command, "--filter", "-F");
  if (selected) {
    const filtered = packages.find(({ name }) => name === selected);
    if (filtered) return filtered;
  }

  const commandCwd = commandWorkingDirectory(command, cwd);
  for (const token of command) {
    if (token.startsWith("-")) continue;
    const candidate = resolve(commandCwd, token);
    const owner = packages.find(({ dir }) => containsPath(dir, candidate));
    if (owner) return owner;
  }
  return packages.find(({ dir }) => containsPath(dir, commandCwd));
}

/** Source directories most likely to affect the command, using workspace dependency metadata. */
export function devWatchDirectories(
  command: readonly string[],
  cwd: string = process.cwd(),
): string[] {
  const root = resolveRepoRoot(cwd);
  const packages = workspacePackages(root);
  const owner = commandPackage(command, cwd, packages);
  if (!owner) return [commandWorkingDirectory(command, cwd)];
  const dependencies = owner.name ? workspaceDependencyDirectories(owner.name, root) : [];
  return dependencies.length > 0 ? dependencies : [owner.dir];
}

/**
 * Choose watch paths for {@link pathWatch.watchFiles}.
 * Default workspace-package directories apply until `--watch-include` is set;
 * `--watch-exclude` is always passed through as ignore globs.
 */
export function devWatchTargets(
  command: readonly string[],
  cwd: string,
  include: readonly string[] = [],
  exclude: readonly string[] = [],
): { paths: readonly string[]; ignore: readonly string[] } {
  return {
    paths: include.length > 0 ? [...include] : devWatchDirectories(command, cwd),
    ignore: [...exclude],
  };
}

/** Compare one raw terminal character with the configured restart key. */
export function isRestartKey(key: string, restartKey: string): boolean {
  return key === restartKey || key.toLocaleLowerCase() === restartKey.toLocaleLowerCase();
}

/** Supervise one command until the user or host stops the task. */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  let options: DevWatchOptions;
  try {
    options = parseDevWatchOptions(args);
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    if (err.exitCode !== 0) process.exitCode = err.exitCode;
    return;
  }
  const cwd = process.cwd();
  const root = resolveRepoRoot(cwd);
  const { paths: watchPaths, ignore: watchIgnore } = devWatchTargets(
    options.command,
    cwd,
    options.watchInclude,
    options.watchExclude,
  );
  const commandLabel = options.command.map((part) => JSON.stringify(part)).join(" ");
  let child: exec.ChildProcessResult | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restartReason: string | undefined;
  let restarting = false;
  let stopping = false;

  const watcher = await pathWatch.watchFiles([...watchPaths], {
    cwd: root,
    ignore: watchIgnore.length > 0 ? [...watchIgnore] : undefined,
    ignoreInitial: true,
    ignoreOptions: {
      git: true,
    },
  });

  async function stopChild(): Promise<void> {
    const current = child;
    if (!current) return;
    child = undefined;
    try {
      await exec.kill(current, {
        gracefulTimeoutMs: SHUTDOWN_TIMEOUT_MS,
        forceTimeoutMs: SHUTDOWN_TIMEOUT_MS,
      });
    } catch (err) {
      logger.error("failed to stop command process tree", {
        error: errorUtils.toError(err),
      });
    }
  }

  function startChild(reason: string): void {
    logger.info(`${reason}; starting ${commandLabel}`);
    const [command, ...commandArgs] = options.command;
    const current = exec.spawn(command!, commandArgs, {
      cwd,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      check: false,
    });
    child = current;
    void current
      .then(({ exitCode }) => {
        if (child !== current || stopping) return;
        child = undefined;
        logger.warn(
          `command exited with code ${exitCode}; press ${JSON.stringify(options.restartKey)} or change a watched file to restart`,
        );
      })
      .catch((err) => {
        if (child !== current || stopping) return;
        child = undefined;
        logger.error("command failed", { error: errorUtils.toError(err) });
      });
  }

  async function drainRestarts(): Promise<void> {
    if (restarting) return;
    restarting = true;
    try {
      while (restartReason !== undefined && !stopping) {
        const reason = restartReason;
        restartReason = undefined;
        await stopChild();
        if (!stopping) startChild(reason);
      }
    } finally {
      restarting = false;
    }
  }

  function requestRestart(reason: string): void {
    restartReason = reason;
    void drainRestarts();
  }

  function scheduleRestart(): void {
    clearTimeout(timer);
    timer = setTimeout(
      () => requestRestart(`changes settled for ${options.debounceMs}ms`),
      options.debounceMs,
    );
  }

  watcher.on("all", scheduleRestart);
  watcher.on("error", (err) => logger.error("watcher error", { error: errorUtils.toError(err) }));
  watcher.on("ready", () => {
    const count = watchPaths.length;
    const source = options.watchInclude.length > 0 ? "include glob" : "workspace directory";
    logger.info(
      `watching ${count} ${source}${count === 1 ? "" : "s"} with ${options.debounceMs}ms restart debounce`,
    );
    logger.info(`press ${JSON.stringify(options.restartKey)} to restart; Ctrl-C to stop`);
  });

  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? Boolean(stdin.isRaw) : false;
  const onInput = (chunk: Buffer | string): void => {
    for (const key of String(chunk)) {
      if (key === "\u0003") {
        void shutdown();
        return;
      }
      if (isRestartKey(key, options.restartKey)) {
        clearTimeout(timer);
        requestRestart("manual restart requested");
      }
    }
  };
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onInput);

  let finish!: () => void;
  const complete = new Promise<void>((resolveComplete) => {
    finish = resolveComplete;
  });

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    restartReason = undefined;
    stdin.off("data", onInput);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdin.pause();
    await Promise.allSettled([watcher.close(), stopChild()]);
    finish();
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => void shutdown());
  }

  requestRestart("initial start");
  await complete;
}

await runTaskMain(import.meta, main);
