import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseArgv } from "@dbx-tools/cli-args";
import { shutdownProcessTree } from "@dbx-tools/core";
import { boundedRetryDelay } from "@dbx-tools/shared-core";
import * as systrayModule from "systray2";
import type SysTrayType from "systray2";
import type { MenuItem } from "systray2";
import { z } from "zod";

import { readServiceDefinition } from "./_config.ts";
import {
  closeServiceControl,
  listenForServiceControl,
  type ServiceControlResponse,
} from "./_control.ts";
import { defaultRuntimeContext, resolveServicePaths, type ServicePaths } from "./_paths.ts";
import type { CliServiceCommand, CliServiceDefinition, CliServiceMenuItem } from "./definition.ts";

const CHILD_TERMINATE_TIMEOUT_MILLISECONDS = 30_000;
const CHILD_KILL_TIMEOUT_MILLISECONDS = 5_000;
// Startup entries do not supervise the host, so the host restarts a managed
// command that exits early (for example, before VPN or network is up at login).
const DEFAULT_RESTART_BACKOFF: ServiceRestartBackoff = {
  delaysMilliseconds: [1_000, 2_000, 5_000, 10_000, 30_000, 60_000],
  stableMilliseconds: 60_000,
};
const CliServiceHostOptionsSchema = z.object({
  serviceConfig: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Serialized CLI service definition")
    .meta({ env: [], short: false }),
});
const SysTray = systrayConstructor();

interface ActionMenuItem extends MenuItem {
  readonly click?: () => void;
}

type ServiceTray = Pick<SysTrayType, "ready" | "onClick" | "onError" | "onExit"> & {
  readonly process?: ChildProcess | null;
};

interface ServiceRestartBackoff {
  /** Delays between consecutive early exits; the last entry repeats. */
  readonly delaysMilliseconds: readonly number[];
  /** Uptime after which an exit is treated as a fresh failure rather than consecutive. */
  readonly stableMilliseconds: number;
}

interface CliServiceHostDependencies {
  readonly createTray?: () => ServiceTray;
  readonly listenForControl?: typeof listenForServiceControl;
  readonly restartBackoff?: ServiceRestartBackoff;
}

function systrayConstructor(): typeof SysTrayType {
  const loaded: unknown = systrayModule.default;
  if (typeof loaded === "function") return loaded as typeof SysTrayType;
  const nested =
    loaded && typeof loaded === "object" ? (loaded as { default?: unknown }).default : undefined;
  if (typeof nested === "function") return nested as typeof SysTrayType;
  throw new TypeError("systray2 did not provide a constructor");
}

export class CliServiceHost {
  private readonly definition: CliServiceDefinition;
  private readonly paths: ServicePaths;
  private readonly requestStop: () => void;
  private readonly createServiceTray: () => ServiceTray;
  private readonly listenForControl: typeof listenForServiceControl;
  private readonly restartBackoff: ServiceRestartBackoff;
  private tray?: ServiceTray;
  private auth?: ChildProcess;
  private authRestartTimer?: ReturnType<typeof setTimeout>;
  private authRestartAttempt = 0;
  private service?: ChildProcess;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private restartAttempt = 0;
  private control?: Awaited<ReturnType<typeof listenForServiceControl>>;
  private stopping = false;

  constructor(
    definition: CliServiceDefinition,
    paths: ServicePaths,
    requestStop: () => void,
    dependencies: CliServiceHostDependencies = {},
  ) {
    this.definition = definition;
    this.paths = paths;
    this.requestStop = requestStop;
    this.createServiceTray = dependencies.createTray ?? (() => this.createTray());
    this.listenForControl = dependencies.listenForControl ?? listenForServiceControl;
    this.restartBackoff = dependencies.restartBackoff ?? DEFAULT_RESTART_BACKOFF;
  }

  async start(): Promise<void> {
    await mkdir(this.paths.directory, { recursive: true });
    try {
      this.control = await this.listenForControl(
        this.paths.controlAddress,
        () => this.status(),
        this.requestStop,
      );
      this.tray = this.createServiceTray();
      void this.initializeTray(this.tray);
      this.startManagedCommand();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.authRestartTimer);
    this.authRestartTimer = undefined;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (this.control) {
      await closeServiceControl(this.control, this.paths.controlAddress);
      this.control = undefined;
    }
    if (this.tray) {
      await stopTray(this.tray);
      this.tray = undefined;
    }
    if (this.auth) {
      await stopProcess(this.auth);
      this.auth = undefined;
    }
    if (this.service) {
      await stopProcess(this.service);
      this.service = undefined;
    }
  }

  private startManagedCommand(): void {
    const authCommand =
      this.definition.waitForAuth !== "false" ? this.definition.authCommand : undefined;
    if (authCommand) {
      this.startAuthPreflight(authCommand);
      return;
    }
    if (this.definition.command) this.startService(this.definition.command);
  }

  private startAuthPreflight(command: CliServiceCommand): void {
    const child = this.startProcess(command);
    this.auth = child;
    child.once("error", () => {
      if (this.auth !== child) return;
      this.auth = undefined;
      this.requestStop();
    });
    child.once("exit", (code, signal) => {
      if (this.stopping || this.auth !== child) return;
      this.auth = undefined;
      if (code === 0) {
        this.authRestartAttempt = 0;
        void logMessage(this.paths.hostLog, "authentication preflight succeeded");
        if (this.definition.command) this.startService(this.definition.command);
        return;
      }
      this.scheduleAuthRestart(command, signal ?? String(code));
    });
  }

  private scheduleAuthRestart(command: CliServiceCommand, reason: string): void {
    const delay = boundedRetryDelay(
      this.authRestartAttempt,
      this.restartBackoff.delaysMilliseconds,
    );
    this.authRestartAttempt += 1;
    void logMessage(
      this.paths.hostLog,
      `authentication preflight exited (${reason}); retrying in ${delay / 1000}s`,
    );
    this.authRestartTimer = setTimeout(() => {
      this.authRestartTimer = undefined;
      if (this.stopping) return;
      try {
        this.startAuthPreflight(command);
      } catch (error) {
        void logError(this.paths.hostLog, error);
        this.requestStop();
      }
    }, delay);
  }

  private status(): ServiceControlResponse {
    return {
      running: true,
      pid: process.pid,
      ...(this.service?.pid ? { servicePid: this.service.pid } : {}),
    };
  }

  private async initializeTray(tray: ServiceTray): Promise<void> {
    try {
      await tray.ready();
      if (this.stopping || this.tray !== tray) return;
      tray.onError((error) => {
        void logError(this.paths.hostLog, error);
      });
      tray.onExit((code, signal) => {
        if (this.tray === tray) this.tray = undefined;
        if (this.stopping) return;
        void logMessage(this.paths.hostLog, `system tray exited (${signal ?? String(code)})`);
      });
      await tray.onClick((action) => {
        const item = action.item as ActionMenuItem;
        item.click?.();
      });
    } catch (error) {
      await logError(this.paths.hostLog, error);
      if (this.tray !== tray) return;
      await stopTray(tray);
      this.tray = undefined;
    }
  }

  private startService(command: CliServiceCommand): void {
    const startedAt = Date.now();
    const child = this.startProcess(command);
    this.service = child;
    // A spawn failure (missing or non-executable binary) will not fix itself.
    child.once("error", () => {
      if (this.service !== child) return;
      this.service = undefined;
      this.requestStop();
    });
    child.once("exit", (code, signal) => {
      if (this.stopping || this.service !== child) return;
      this.service = undefined;
      this.scheduleServiceRestart(command, Date.now() - startedAt, signal ?? String(code));
    });
  }

  private scheduleServiceRestart(
    command: CliServiceCommand,
    uptimeMilliseconds: number,
    reason: string,
  ): void {
    const { delaysMilliseconds, stableMilliseconds } = this.restartBackoff;
    if (uptimeMilliseconds >= stableMilliseconds) this.restartAttempt = 0;
    const delay = boundedRetryDelay(this.restartAttempt, delaysMilliseconds);
    this.restartAttempt += 1;
    void logMessage(
      this.paths.hostLog,
      `managed service exited (${reason}); restarting in ${delay / 1000}s`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping) return;
      try {
        this.startService(command);
      } catch (error) {
        void logError(this.paths.hostLog, error);
        this.requestStop();
      }
    }, delay);
  }

  private startProcess(command: CliServiceCommand): ChildProcess {
    if (!command.executable) {
      throw new Error("installed service commands require an executable");
    }
    const logDescriptor = openSync(this.paths.processLog, "a");
    const child = spawn(command.executable, command.arguments ?? [], {
      cwd: command.cwd,
      env: { ...process.env, ...command.environment },
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
    closeSync(logDescriptor);
    child.once("error", (error) => {
      void logError(this.paths.hostLog, error);
    });
    return child;
  }

  private createTray(): SysTrayType {
    return new SysTray({
      menu: {
        icon: this.definition.icon,
        title: "",
        tooltip: `${this.definition.name} ${this.definition.version}`,
        items: this.menuItems(),
        isTemplateIcon: this.definition.isTemplateIcon,
      },
      debug: false,
      copyDir: false,
    });
  }

  private menuItems(): ActionMenuItem[] {
    const custom = (this.definition.menu ?? []).map((item) => this.menuItem(item));
    return [
      {
        title: `${this.definition.name} - ${this.definition.version}`,
        tooltip: "",
        enabled: false,
      },
      ...custom,
      { ...SysTray.separator },
      {
        title: "Quit",
        tooltip: `Stop ${this.definition.name}`,
        click: this.requestStop,
      },
    ];
  }

  private menuItem(item: CliServiceMenuItem): ActionMenuItem {
    if (item.type === "separator") return { ...SysTray.separator };
    if (item.type === "url") {
      return {
        title: item.label,
        tooltip: item.url,
        click: () => {
          this.openUrl(item.url);
        },
      };
    }
    return {
      title: item.label,
      tooltip: "",
      click: () => {
        const child = this.startProcess(item.command);
        child.unref();
      },
    };
  }

  private openUrl(url: string): void {
    const command =
      process.platform === "darwin"
        ? { executable: "open", arguments: [url] }
        : process.platform === "win32"
          ? {
              executable: "rundll32.exe",
              arguments: ["url.dll,FileProtocolHandler", url],
            }
          : { executable: "xdg-open", arguments: [url] };
    const child = this.startProcess(command);
    child.unref();
  }
}

async function runCliServiceHost(configFile: string): Promise<void> {
  process.chdir(dirname(process.execPath));
  const definition = await readServiceDefinition(configFile);
  const runtime = defaultRuntimeContext();
  const paths = resolveServicePaths(definition, runtime);
  let requestStop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const host = new CliServiceHost(definition, paths, requestStop);
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    await host.start();
    await stopped;
  } finally {
    await host.stop();
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  await shutdownProcessTree(child, {
    terminateTimeout: CHILD_TERMINATE_TIMEOUT_MILLISECONDS,
    killTimeout: CHILD_KILL_TIMEOUT_MILLISECONDS,
  });
}

async function stopTray(tray: ServiceTray): Promise<void> {
  const child = tray.process;
  if (child) await stopProcess(child);
}

async function logError(path: string, error: unknown): Promise<void> {
  await logMessage(path, error instanceof Error ? (error.stack ?? error.message) : String(error));
}

async function logMessage(path: string, message: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${new Date().toISOString()} ${message}\n`, "utf8");
}

const { serviceConfig: configFile } = parseArgv(CliServiceHostOptionsSchema);
if (configFile) {
  void runCliServiceHost(configFile).catch(async (error: unknown) => {
    await logError(join(dirname(configFile), "host.log"), error);
    process.exitCode = 1;
  });
}
