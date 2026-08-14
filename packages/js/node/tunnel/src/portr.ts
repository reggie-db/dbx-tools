/**
 * portr install, config, and launch support for the tunnel runtime.
 *
 * The binary and config use portr's conventional `$HOME/.portr` tree. The
 * install is idempotent (the installer skips an existing executable). The
 * config is rendered from `TUNNEL_PUBLIC_DOMAIN`
 * (`<subdomain>.<server>`) + `PORTR_TOKEN` and points portr at the PUBLIC port
 * (the proxy listens there).
 *
 * @module
 */
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { bin, config } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import { TUNNEL_CONFIG } from "./_config.ts";
import { superviseProcessForever, type ProcessSupervisor } from "./supervisor.ts";

const logger = log.logger("tunnel:portr");
const PORTR_VERSION = "1.0.15-sse.2";
const PORTR_RELEASE_URL = `https://github.com/reggie-db/portr/releases/download/v${PORTR_VERSION}`;
const PORTR_MIN_VERSION = "v1.0.15";
const execFileAsync = promisify(execFile);

/** Options for installing the portr executable. */
export interface PortrInstallOptions {
  /** Home directory containing `.portr`; defaults to the OS home directory. */
  homeDir?: string;
}

/** Resolved portr wiring, or `undefined` when no tunnel is configured. */
export interface PortrConfig {
  subdomain: string;
  server: string;
  token: string;
  port: number;
}

/**
 * Resolve portr config from `TUNNEL_PUBLIC_DOMAIN` + `PORTR_TOKEN`, or an
 * explicit `subdomain`. The domain is `<subdomain>.<server>` (e.g.
 * `demo.apps.dbx.tools`). Returns `undefined` (no tunnel) when the token or a
 * usable domain is absent.
 */
export function resolvePortrConfig(opts: {
  publicDomain?: string;
  subdomain?: string;
  token?: string;
  port: number;
}): PortrConfig | undefined {
  // PORTR_* is upstream portr's own namespace, so it keeps its name.
  const token = config.string(opts.token, "PORTR_TOKEN");
  const domain = config.string(opts.publicDomain, "PUBLIC_DOMAIN", TUNNEL_CONFIG);
  if (!token) return undefined;
  let subdomain = opts.subdomain;
  let server: string | undefined;
  if (domain) {
    subdomain ??= domain.split(".")[0];
    server = domain.slice(domain.indexOf(".") + 1);
  }
  server ??= config.text("PORTR_SERVER");
  if (!subdomain || !server || server === domain) return undefined;
  return { subdomain, server, token, port: opts.port };
}

/** GitHub release asset name for the current or supplied OS/architecture. */
export function portrAssetName(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const osName = platform === "darwin" ? "Darwin" : platform === "linux" ? "Linux" : undefined;
  const archName = arch === "arm64" ? "arm64" : arch === "x64" ? "x86_64" : undefined;
  if (!osName || !archName) {
    throw new Error(`portr has no supported release asset for ${platform}/${arch}`);
  }
  return `portr_${version}_${osName}_${archName}.zip`;
}

function portrDownloadUrl(): string {
  const assetName = portrAssetName(PORTR_VERSION);
  logger.info("installing portr", { version: PORTR_VERSION, asset: assetName });
  return `${PORTR_RELEASE_URL}/${assetName}`;
}

/** Install portr when absent and return the environment used by its process. */
export async function installPortr(options: PortrInstallOptions = {}): Promise<NodeJS.ProcessEnv> {
  const homeDir = options.homeDir ?? os.homedir();
  const context = await bin.ensure("portr", portrDownloadUrl, {
    autoUnpackage: true,
    homeDir,
    minVersion: PORTR_MIN_VERSION,
    selector: ({ source }) => join(source, "portr"),
    versionParser: (output) => {
      const version = bin.parseVersion(output);
      return version === PORTR_VERSION ? version : undefined;
    },
  });
  return {
    ...process.env,
    HOME: homeDir,
    PORTR_AUTO_ADD_PATH: "no",
    PATH: [context.binDir, process.env.PATH ?? ""].join(delimiter),
  };
}

/** Render `~/.portr/config.yaml` for the resolved tunnel. */
export async function writePortrConfig(
  config: PortrConfig,
  childEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const path = join(childEnv.HOME ?? os.homedir(), ".portr", "config.yaml");
  await writeFile(
    path,
    [
      `server_url: ${config.server}`,
      `ssh_url: ${config.server}:4444`,
      `secret_key: ${config.token}`,
      "disable_dashboard: true",
      "disable_tui: true",
      "tunnels:",
      `  - name: ${config.subdomain}`,
      `    subdomain: ${config.subdomain}`,
      `    port: ${config.port}`,
      "",
    ].join("\n"),
  );
}

/** Launch `portr start` as a child process (caller supervises + kills it). */
export async function startPortr(
  config: PortrConfig,
  childEnv: NodeJS.ProcessEnv,
): Promise<ReturnType<typeof spawn>> {
  // Reclaim the subdomain from any portr left by a previous boot in this container.
  await execFileAsync("pkill", ["-x", "portr"]).catch(() => undefined);

  logger.info(`portr tunneling https://${config.subdomain}.${config.server} -> :${config.port}`);
  return spawn("portr", ["start"], { env: childEnv, stdio: "inherit" });
}

export function supervisePortr(config: PortrConfig, childEnv: NodeJS.ProcessEnv): ProcessSupervisor {
  return superviseProcessForever({
    name: "portr",
    logger,
    start: () => startPortr(config, childEnv),
  });
}
