import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import SysTray, { type MenuItem } from "systray2";

import { readServiceDefinition } from "./_config.ts";
import {
  closeServiceControl,
  listenForServiceControl,
  type ServiceControlResponse,
} from "./_control.ts";
import { defaultRuntimeContext, resolveServicePaths, type ServicePaths } from "./_paths.ts";
import type { CliServiceCommand, CliServiceDefinition, CliServiceMenuItem } from "./definition.ts";

const CHILD_STOP_TIMEOUT_MILLISECONDS = 5_000;

interface ActionMenuItem extends MenuItem {
  readonly click?: () => void;
}

class CliServiceHost {
  private readonly definition: CliServiceDefinition;
  private readonly paths: ServicePaths;
  private readonly requestStop: () => void;
  private tray?: SysTray;
  private service?: ChildProcess;
  private control?: Awaited<ReturnType<typeof listenForServiceControl>>;
  private stopping = false;

  constructor(definition: CliServiceDefinition, paths: ServicePaths, requestStop: () => void) {
    this.definition = definition;
    this.paths = paths;
    this.requestStop = requestStop;
  }

  async start(): Promise<void> {
    await mkdir(this.paths.directory, { recursive: true });
    this.service = this.definition.command
      ? this.startProcess(this.definition.command, true)
      : undefined;
    this.tray = this.createTray();
    await this.tray.ready();
    this.tray.onError((error) => {
      void logError(this.paths.hostLog, error);
      this.requestStop();
    });
    this.tray.onExit((code, signal) => {
      if (this.stopping) return;
      void logMessage(this.paths.hostLog, `system tray exited (${signal ?? String(code)})`);
      this.requestStop();
    });
    await this.tray.onClick((action) => {
      const item = action.item as ActionMenuItem;
      item.click?.();
    });
    this.control = await listenForServiceControl(
      this.paths.controlAddress,
      () => this.status(),
      this.requestStop,
    );
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.control) {
      await closeServiceControl(this.control, this.paths.controlAddress);
      this.control = undefined;
    }
    if (this.tray) {
      if (this.tray.process.exitCode === null && this.tray.process.signalCode === null) {
        await this.tray.kill(false);
      }
      this.tray = undefined;
    }
    if (this.service) {
      await stopProcess(this.service);
      this.service = undefined;
    }
  }

  private status(): ServiceControlResponse {
    return {
      running: true,
      pid: process.pid,
      ...(this.service?.pid ? { servicePid: this.service.pid } : {}),
    };
  }

  private startProcess(command: CliServiceCommand, managed: boolean): ChildProcess {
    if (!command.executable) {
      throw new Error("installed service commands require an executable");
    }
    const logDescriptor = openSync(this.paths.processLog, "a");
    const child = spawn(command.executable, command.arguments ?? [], {
      cwd: command.cwd,
      env: process.env,
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
    closeSync(logDescriptor);
    child.once("error", (error) => {
      void logError(this.paths.hostLog, error);
      if (managed) this.requestStop();
    });
    child.once("exit", (code, signal) => {
      if (!this.stopping && managed) {
        void logMessage(this.paths.hostLog, `managed service exited (${signal ?? String(code)})`);
        this.requestStop();
      }
    });
    return child;
  }

  private createTray(): SysTray {
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
        const child = this.startProcess(item.command, false);
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
    const child = this.startProcess(command, false);
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
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timedOut = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), CHILD_STOP_TIMEOUT_MILLISECONDS);
  });
  if ((await Promise.race([exited, timedOut])) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

async function logError(path: string, error: unknown): Promise<void> {
  await logMessage(path, error instanceof Error ? (error.stack ?? error.message) : String(error));
}

async function logMessage(path: string, message: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${new Date().toISOString()} ${message}\n`, "utf8");
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configFile = argumentValue("--service-config");
if (configFile) {
  void runCliServiceHost(configFile).catch(async (error: unknown) => {
    await logError(join(dirname(configFile), "host.log"), error);
    process.exitCode = 1;
  });
}
