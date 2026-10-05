import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { CliServiceDefinition } from "./definition.ts";

export interface ServiceRuntimeContext {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly homeDirectory: string;
  readonly temporaryDirectory: string;
}

export interface ServicePaths {
  readonly directory: string;
  readonly configFile: string;
  readonly hostLog: string;
  readonly processLog: string;
  readonly controlAddress: string;
  readonly startupFile: string;
}

export function defaultRuntimeContext(): ServiceRuntimeContext {
  return {
    platform: process.platform,
    environment: process.env,
    homeDirectory: homedir(),
    temporaryDirectory: tmpdir(),
  };
}

export function resolveServicePaths(
  definition: CliServiceDefinition,
  runtime: ServiceRuntimeContext,
): ServicePaths {
  const directory = definition.dataDirectory
    ? resolve(definition.dataDirectory)
    : join(configurationRoot(runtime), definition.id);
  return {
    directory,
    configFile: join(directory, "service.json"),
    hostLog: join(directory, "host.log"),
    processLog: join(directory, "service.log"),
    controlAddress: controlAddress(definition.id, runtime),
    startupFile: startupFile(definition.id, runtime),
  };
}

function configurationRoot(runtime: ServiceRuntimeContext): string {
  if (runtime.platform === "darwin") {
    return join(runtime.homeDirectory, "Library", "Application Support");
  }
  if (runtime.platform === "win32") {
    return resolveEnvironmentPath(
      runtime.environment.APPDATA,
      join(runtime.homeDirectory, "AppData", "Roaming"),
    );
  }
  return resolveEnvironmentPath(
    runtime.environment.XDG_CONFIG_HOME,
    join(runtime.homeDirectory, ".config"),
  );
}

function controlAddress(id: string, runtime: ServiceRuntimeContext): string {
  const token = createHash("sha256").update(id).digest("hex").slice(0, 16);
  if (runtime.platform === "win32") {
    return `\\\\.\\pipe\\dbx-tools-cli-service-${token}`;
  }
  return join(runtime.temporaryDirectory, `dbx-tools-cli-service-${token}.sock`);
}

function startupFile(id: string, runtime: ServiceRuntimeContext): string {
  if (runtime.platform === "darwin") {
    return join(runtime.homeDirectory, "Library", "LaunchAgents", `${id}.plist`);
  }
  if (runtime.platform === "win32") {
    return join(
      resolveEnvironmentPath(
        runtime.environment.APPDATA,
        join(runtime.homeDirectory, "AppData", "Roaming"),
      ),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      `${id}.cmd`,
    );
  }
  return join(
    resolveEnvironmentPath(
      runtime.environment.XDG_CONFIG_HOME,
      join(runtime.homeDirectory, ".config"),
    ),
    "autostart",
    `${id}.desktop`,
  );
}

function resolveEnvironmentPath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return isAbsolute(value) ? value : resolve(value);
}
