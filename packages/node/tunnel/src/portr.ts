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
import { chmod, writeFile } from "node:fs/promises";
import os from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { bin } from "@dbx-tools/core";
import { env, log } from "@dbx-tools/shared-core";
import { PUBLIC_DOMAIN_ENV } from "./env.ts";

const logger = log.logger("tunnel:portr");
const PORTR_LATEST_RELEASE_URL = "https://api.github.com/repos/amalshaji/portr/releases/latest";
const execFileAsync = promisify(execFile);

interface PortrRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
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
  const token = env.string(opts.token, "PORTR_TOKEN");
  const domain = env.string(opts.publicDomain, PUBLIC_DOMAIN_ENV);
  if (!token) return undefined;
  let subdomain = opts.subdomain;
  let server: string | undefined;
  if (domain) {
    subdomain ??= domain.split(".")[0];
    server = domain.slice(domain.indexOf(".") + 1);
  }
  server ??= env.text("PORTR_SERVER") ?? undefined;
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

async function portrDownloadUrl(): Promise<string> {
  const releaseResponse = await fetch(PORTR_LATEST_RELEASE_URL, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "@dbx-tools/tunnel",
    },
  });
  if (!releaseResponse.ok) {
    throw new Error(`portr release lookup failed (${releaseResponse.status})`);
  }
  const release = (await releaseResponse.json()) as PortrRelease;
  const version = release.tag_name.replace(/^v/, "");

  const assetName = portrAssetName(version);
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset) throw new Error(`portr release ${release.tag_name} has no ${assetName}`);

  logger.info("installing portr", { version, asset: assetName });
  return asset.browser_download_url;
}

/** Install portr when absent and return the environment used by its process. */
export async function installPortr(options: PortrInstallOptions = {}): Promise<NodeJS.ProcessEnv> {
  const homeDir = options.homeDir ?? os.homedir();
  const context = await bin.ensure("portr", portrDownloadUrl, {
    autoUnpackage: true,
    homeDir,
    selector: async ({ source }) => {
      const selected = join(source, "portr");
      await chmod(selected, 0o755);
      return selected;
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
