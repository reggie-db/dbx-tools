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
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import {
  AppKitChildProcess,
  type AppKitChildProcessOptions,
} from "@dbx-tools/appkit/child-process";
import { bin, configUtils } from "@dbx-tools/core";
import { log, options as sharedOptions, stringUtils } from "@dbx-tools/shared-core";
import { z } from "zod";
import { TUNNEL_CONFIG } from "./_config.ts";
import { superviseProcessForever, type ProcessSupervisor } from "./supervisor.ts";

const logger = log.logger("tunnel:portr");
const PORTR_VERSION = "1.0.15-sse.2";
const PORTR_RELEASE_URL = `https://github.com/reggie-db/portr/releases/download/v${PORTR_VERSION}`;
const PORTR_MIN_VERSION = "v1.0.15";
const execFileAsync = promisify(execFile);

const EMOJI = /\p{Extended_Pictographic}\uFE0F?/gu;

/** Remove pictographs from third-party process output before forwarding it. */
export function normalizePortrOutput(value: string): string {
  return value.replace(EMOJI, "").replace(/^[ \t]+/gm, "");
}

/** Options for installing the portr executable. */
export interface PortrInstallOptions {
  /** Home directory containing `.portr`; defaults to the OS home directory. */
  homeDir?: string;
}

/** Resolved portr wiring, or `undefined` when no tunnel is configured. */
export interface PortrConfig {
  subdomain: string;
  server: string;
  sshUrl: string;
  token: string;
  port: number;
}

export const PortrOptionsSchema = z
  .object({
    publicDomain: z.string().trim().min(1).optional().describe("Public tunnel domain."),
    subdomain: z.string().trim().min(1).optional().describe("Portr subdomain."),
    sshUrl: z.string().trim().min(1).optional().describe("Portr SSH control endpoint."),
    token: z.string().trim().min(1).optional().describe("Portr authentication token."),
    port: sharedOptions.tcpPortOrZeroSchema.describe("Public listener port."),
  })
  .strict()
  .describe("Portr tunnel resolution options.");

export type PortrOptions = z.input<typeof PortrOptionsSchema>;

/**
 * Resolve portr config from `TUNNEL_PUBLIC_DOMAIN` + `PORTR_TOKEN`, or an
 * explicit `subdomain`. The domain is `<subdomain>.<server>` (e.g.
 * `demo.apps.dbx.tools`). Returns `undefined` (no tunnel) when the token or a
 * usable domain is absent.
 */
export function resolvePortrConfig(opts: PortrOptions): PortrConfig | undefined {
  const options = PortrOptionsSchema.parse(opts);
  // PORTR_* is upstream portr's own namespace, so it keeps its name.
  const token = configUtils.string(options.token, "PORTR_TOKEN");
  const domain = configUtils.string(options.publicDomain, "TUNNEL_PUBLIC_DOMAIN", TUNNEL_CONFIG);
  if (!token) return undefined;
  let subdomain = options.subdomain;
  let server: string | undefined;
  if (domain) {
    subdomain ??= domain.split(".")[0];
    server = domain.slice(domain.indexOf(".") + 1);
  }
  server ??= configUtils.text("PORTR_SERVER");
  if (!subdomain || !server || server === domain) return undefined;
  const sshUrl = configUtils.string(options.sshUrl, "PORTR_SSH_URL") ?? `${server}:4444`;
  return { subdomain, server, sshUrl, token, port: options.port };
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
  const directory = join(childEnv.HOME ?? os.homedir(), ".portr");
  const path = join(directory, "config.yaml");
  await mkdir(directory, { recursive: true });
  // prettier-ignore
  const template = (
    // ============================================================================
    /*yaml*/`
    server_url: ${config.server}
    ssh_url: ${config.sshUrl}
    secret_key: ${config.token}
    disable_dashboard: true
    disable_tui: true
    tunnels:
      - name: ${config.subdomain}
        subdomain: ${config.subdomain}
        port: ${config.port}
    `
    // ============================================================================
  );
  const contents = stringUtils.dedent(template, { trimEnd: false });
  await writeFile(path, contents);
}

/** Launch `portr start` as a child process (caller supervises + kills it). */
export async function startPortr(
  config: PortrConfig,
  childEnv: NodeJS.ProcessEnv,
  options: AppKitChildProcessOptions = {},
): Promise<AppKitChildProcess> {
  // Reclaim the subdomain from any portr left by a previous boot in this container.
  await execFileAsync("pkill", ["-x", "portr"]).catch(() => undefined);

  logger.info(`portr tunneling https://${config.subdomain}.${config.server} -> :${config.port}`);
  const child = new AppKitChildProcess(
    [
      "portr",
      ["start"],
      {
        env: childEnv,
        stdin: "inherit",
        stdout: {
          onLine: (line) => process.stdout.write(`${normalizePortrOutput(line)}\n`),
          capture: false,
        },
        stderr: {
          onLine: (line) => process.stderr.write(`${normalizePortrOutput(line)}\n`),
          capture: false,
        },
      },
    ],
    options,
  );
  child.start();
  return child;
}

/**
 * Probe the public portr URL. A registered tunnel is healthy even when the app
 * returns an auth challenge (401/302) - those prove the edge still has the
 * subdomain. Only an explicit `unregistered-subdomain` (or any other
 * `x-portr-error`) means the client must be restarted.
 */
export async function probePortrPublicUrl(publicUrl: string): Promise<boolean> {
  const response = await fetch(publicUrl, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.headers.get("x-portr-error") === "true") return false;
  return true;
}

/** Supervise the Portr client for a resolved tunnel configuration. */
export function supervisePortr(
  config: PortrConfig,
  childEnv: NodeJS.ProcessEnv,
): ProcessSupervisor {
  const publicUrl = `https://${config.subdomain}.${config.server}`;
  return superviseProcessForever({
    name: "portr",
    logger,
    start: () => startPortr(config, childEnv, { gracefulTimeoutMs: 10_000 }),
    // Kill + restart when the edge drops the registration while the local
    // process is still alive. Without this, lensiq.apps.dbx.tools (and any
    // other in-process tunnel) stays unregistered until a full app bounce.
    isHealthy: () => probePortrPublicUrl(publicUrl),
  });
}
