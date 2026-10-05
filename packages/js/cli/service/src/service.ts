/**
 * Install, start, stop, and inspect a system-tray user service.
 *
 * @module
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as bin from "@dbx-tools/core/bin";
import * as exec from "@dbx-tools/core/exec";

import { readServiceDefinition, writeServiceDefinition } from "./_config.ts";
import { requestServiceControl } from "./_control.ts";
import {
  defaultRuntimeContext,
  resolveServicePaths,
  type ServiceRuntimeContext,
} from "./_paths.ts";
import { installStartup, removeStartup, type ServiceLaunch } from "./_startup.ts";
import {
  CliServiceDefinitionSchema,
  type CliServiceCommand,
  type CliServiceDefinition,
  type CliServiceMenuItem,
} from "./definition.ts";

const DEFAULT_START_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_STOP_TIMEOUT_MILLISECONDS = 10_000;
const POLL_INTERVAL_MILLISECONDS = 100;

/** Compile one TypeScript or JavaScript entrypoint into a standalone executable. */
export type CliServiceCompiler = (entrypoint: string, output: string) => Promise<void>;

/** Host runtime overrides for tests, embedded distributions, and nonstandard homes. */
export interface CliServiceRuntimeOptions {
  /** Operating system used for configuration and startup registration. */
  readonly platform?: NodeJS.Platform;
  /** Environment used to locate platform configuration directories. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  /** Home directory used when platform environment variables are absent. */
  readonly homeDirectory?: string;
  /** Temporary directory used for the local control socket. */
  readonly temporaryDirectory?: string;
  /** Shared dbx-tools home containing installed service binaries. */
  readonly globalHomeDirectory?: string;
  /** Package-provided Bun executable override. */
  readonly bunExecutable?: string;
  /** Standalone compiler override. */
  readonly compile?: CliServiceCompiler;
  /** System-tray host source entrypoint override. */
  readonly hostEntrypoint?: string;
  /** systray2 native executable override. */
  readonly trayExecutable?: string;
}

/** Options controlling service installation. */
export interface CliServiceInstallOptions {
  /** Start the service immediately after writing its configuration and login entry. */
  readonly start?: boolean;
}

/** Current installation and process state for a system-tray service. */
export interface CliServiceStatus {
  /** Whether the serialized service definition exists. */
  readonly installed: boolean;
  /** Whether the tray host answered its local control socket. */
  readonly running: boolean;
  /** Tray host process ID when running. */
  readonly pid?: number;
  /** Managed child process ID when the definition includes a command. */
  readonly servicePid?: number;
}

/** Lifecycle contract consumed by CLI command builders. */
export interface CliServiceLifecycle {
  /** Install the login entry and optionally start the service. */
  install(options?: CliServiceInstallOptions): Promise<void>;
  /** Start the installed service when it is not already running. */
  start(): Promise<void>;
  /** Stop the running tray host and its managed child process. */
  stop(): Promise<void>;
  /** Stop and start the installed service. */
  restart(): Promise<void>;
  /** Stop the service and remove its login entry and package-owned state. */
  uninstall(): Promise<void>;
  /** Read the current installation and process state. */
  status(): Promise<CliServiceStatus>;
}

/** Cross-platform lifecycle manager for one system-tray user service. */
export class CliService implements CliServiceLifecycle {
  readonly definition: CliServiceDefinition;

  private readonly runtime: ServiceRuntimeContext;
  private readonly globalHomeDirectory: string;
  private readonly bunExecutable: string;
  private readonly compiler: CliServiceCompiler;
  private readonly hostEntrypoint: string;
  private readonly trayExecutable: string;

  /**
   * Create a lifecycle manager from a serializable definition.
   *
   * @param definition Product-owned service metadata, process, and menu.
   * @param options Host runtime overrides.
   */
  constructor(definition: CliServiceDefinition, options: CliServiceRuntimeOptions = {}) {
    this.definition = CliServiceDefinitionSchema.parse(definition);
    const defaults = defaultRuntimeContext();
    this.runtime = {
      platform: options.platform ?? defaults.platform,
      environment: options.environment ?? defaults.environment,
      homeDirectory: options.homeDirectory ?? defaults.homeDirectory,
      temporaryDirectory: options.temporaryDirectory ?? defaults.temporaryDirectory,
    };
    this.globalHomeDirectory =
      options.globalHomeDirectory ?? join(this.runtime.homeDirectory, ".dbx-tools");
    this.bunExecutable = options.bunExecutable ?? resolveBunExecutable();
    this.compiler =
      options.compile ??
      ((entrypoint, output) => compileWithBun(this.bunExecutable, entrypoint, output));
    this.hostEntrypoint = options.hostEntrypoint ?? resolveHostEntrypoint();
    this.trayExecutable = options.trayExecutable ?? resolveTrayExecutable(this.runtime.platform);
  }

  /** Install the login entry and optionally start the service. */
  async install(options: CliServiceInstallOptions = {}): Promise<void> {
    const paths = resolveServicePaths(this.definition, this.runtime);
    const installedDefinition = await this.installDefinition();
    const host = await this.ensureCompiledBinary(
      this.binaryName(installedDefinition, "service"),
      this.hostEntrypoint,
    );
    await this.ensureTrayBinary();
    await writeServiceDefinition(paths.configFile, installedDefinition);
    await installStartup(
      installedDefinition,
      paths,
      this.runtime,
      this.launch(host.path, paths.configFile),
    );
    if (options.start ?? true) await this.start();
  }

  /** Start the installed service when it is not already running. */
  async start(): Promise<void> {
    const paths = resolveServicePaths(this.definition, this.runtime);
    if (!(await this.status()).installed) {
      throw new Error(`${this.definition.name} is not installed`);
    }
    if ((await requestServiceControl(paths.controlAddress, "status")) !== undefined) return;

    const installedDefinition = await readServiceDefinition(paths.configFile);
    const launch = this.launch(
      this.binaryContext(this.binaryName(installedDefinition, "service")).path,
      paths.configFile,
    );
    const child = spawn(launch.executable, launch.arguments, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    await Promise.race([
      waitForState(
        async () => (await requestServiceControl(paths.controlAddress, "status")) !== undefined,
        true,
        DEFAULT_START_TIMEOUT_MILLISECONDS,
        `${this.definition.name} did not start`,
      ),
      new Promise<never>((_resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          reject(
            new Error(
              `${this.definition.name} host exited before startup (${signal ?? String(code)})`,
            ),
          );
        });
      }),
    ]);
  }

  /** Stop the running tray host and its managed child process. */
  async stop(): Promise<void> {
    const paths = resolveServicePaths(this.definition, this.runtime);
    const response = await requestServiceControl(paths.controlAddress, "stop");
    if (!response) return;
    await waitForState(
      async () => (await requestServiceControl(paths.controlAddress, "status")) !== undefined,
      false,
      DEFAULT_STOP_TIMEOUT_MILLISECONDS,
      `${this.definition.name} did not stop`,
    );
  }

  /** Stop and start the installed service. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Stop the service and remove its login entry and package-owned state. */
  async uninstall(): Promise<void> {
    const paths = resolveServicePaths(this.definition, this.runtime);
    await this.stop();
    await removeStartup(paths);
    await rm(paths.directory, { recursive: true, force: true });
  }

  /** Read the current installation and process state. */
  async status(): Promise<CliServiceStatus> {
    const paths = resolveServicePaths(this.definition, this.runtime);
    const installed = existsSync(paths.configFile);
    const response = await requestServiceControl(paths.controlAddress, "status");
    return {
      installed,
      running: response !== undefined,
      ...(response
        ? {
            pid: response.pid,
            ...(response.servicePid ? { servicePid: response.servicePid } : {}),
          }
        : {}),
    };
  }

  private launch(executable: string, configFile: string): ServiceLaunch {
    return {
      executable,
      arguments: ["--service-config", configFile],
    };
  }

  private async installDefinition(): Promise<CliServiceDefinition> {
    const command = this.definition.command
      ? await this.installCommand(this.definition.command, "command")
      : undefined;
    const menu: CliServiceMenuItem[] = [];
    for (const [index, item] of (this.definition.menu ?? []).entries()) {
      menu.push(
        item.type === "command"
          ? {
              ...item,
              command: await this.installCommand(item.command, `menu-${index + 1}`),
            }
          : item,
      );
    }
    return CliServiceDefinitionSchema.parse({
      ...this.definition,
      ...(command ? { command } : {}),
      ...(menu.length > 0 ? { menu } : {}),
    });
  }

  private async installCommand(
    command: CliServiceCommand,
    purpose: string,
  ): Promise<CliServiceCommand> {
    if (!command.entrypoint) return command;
    const installed = await this.ensureCompiledBinary(
      this.binaryName(this.definition, purpose),
      resolve(command.entrypoint),
    );
    return {
      executable: installed.path,
      ...(command.arguments ? { arguments: command.arguments } : {}),
      ...(command.cwd ? { cwd: command.cwd } : {}),
    };
  }

  private async ensureCompiledBinary(name: string, entrypoint: string): Promise<bin.BinContext> {
    return bin.ensure(
      name,
      async ({ tempDir }) => {
        const output = join(tempDir, executableName(name, this.runtime.platform));
        await this.compiler(entrypoint, output);
        return pathToFileURL(output).href;
      },
      {
        destination: this.binaryContext(name),
        skipVersionCheck: true,
      },
    );
  }

  private async ensureTrayBinary(): Promise<bin.BinContext> {
    const name = trayExecutableName(this.runtime.platform);
    const binDir = join(this.globalHomeDirectory, "bin", "traybin");
    return bin.ensure(name, pathToFileURL(this.trayExecutable).href, {
      destination: {
        root: this.globalHomeDirectory,
        binDir,
        path: join(binDir, name),
      },
      skipVersionCheck: true,
    });
  }

  private binaryContext(name: string): bin.BinContext {
    const binDir = join(this.globalHomeDirectory, "bin");
    return {
      root: this.globalHomeDirectory,
      binDir,
      path: join(binDir, executableName(name, this.runtime.platform)),
    };
  }

  private binaryName(definition: CliServiceDefinition, purpose: string): string {
    return `${definition.id}-${safeToken(definition.version)}-${purpose}`;
  }
}

function resolveHostEntrypoint(): string {
  const current = fileURLToPath(import.meta.url);
  const source =
    extname(current) === ".ts"
      ? join(dirname(current), "_host.ts")
      : resolve(dirname(current), "..", "..", "src", "_host.ts");
  if (existsSync(source)) return source;
  throw new Error(`could not resolve cli-service host source: ${source}`);
}

function resolveBunExecutable(): string {
  return createRequire(import.meta.url).resolve("bun/bin/bun.exe");
}

function trayExecutableName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "tray_darwin_release";
  if (platform === "linux") return "tray_linux_release";
  if (platform === "win32") return "tray_windows_release.exe";
  throw new Error(`systray2 does not support ${platform}`);
}

function resolveTrayExecutable(platform: NodeJS.Platform): string {
  const manifest = createRequire(import.meta.url).resolve("systray2/package.json");
  return join(dirname(manifest), "traybin", trayExecutableName(platform));
}

function executableName(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${name}.exe` : name;
}

function safeToken(value: string): string {
  const token = value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  if (!token) throw new TypeError(`invalid binary version: ${value}`);
  return token;
}

async function compileWithBun(
  bunExecutable: string,
  entrypoint: string,
  output: string,
): Promise<void> {
  await exec.spawn(bunExecutable, ["build", entrypoint, "--compile", "--outfile", output], {
    check: true,
    stdin: "ignore",
    stdout: "capture",
    stderr: "capture",
  });
}

async function waitForState(
  read: () => Promise<boolean>,
  expected: boolean,
  timeoutMilliseconds: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if ((await read()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MILLISECONDS));
  }
  throw new Error(message);
}
