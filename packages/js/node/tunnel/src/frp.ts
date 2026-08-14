/**
 * Install and run an frp client (`frpc`) for a public HTTP tunnel.
 *
 * The defaults match the deployment shape used by inspire-mediamix: a single
 * TLS-terminating host is both the WSS control endpoint and the HTTP custom
 * domain. Callers may point `server` somewhere else when frps is exposed on a
 * separate control host.
 *
 * @module
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { delimiter, join } from "node:path";

import { bin, config } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import { TUNNEL_CONFIG } from "./_config.ts";

const logger = log.logger("tunnel:frp");
const FRP_VERSION = "0.68.1";
const FRP_RELEASE_URL = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}`;

/** Options for installing the frpc executable. */
export interface FrpInstallOptions {
  /** Home directory containing `.frpc`; defaults to the OS home directory. */
  homeDir?: string;
}

/** Resolved frpc wiring, or `undefined` when no FRP tunnel is configured. */
export interface FrpConfig {
  publicDomain: string;
  server: string;
  serverPort: number;
  protocol: string;
  token?: string;
  proxyName: string;
  path: string;
  stripPrefix: boolean;
  port: number;
  targetPort: number;
}

function bareHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^https?:\/\//, "").split("/")[0]?.trim();
  return normalized || undefined;
}

function normalizePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

/** Resolve frpc config from the public domain and FRP-specific environment. */
export function resolveFrpConfig(opts: {
  publicDomain?: string;
  server?: string;
  serverPort?: string | number;
  protocol?: string;
  token?: string;
  proxyName?: string;
  path?: string;
  stripPrefix?: boolean;
  port: number;
  targetPort?: number;
}): FrpConfig | undefined {
  const publicDomain = bareHost(
    config.string(
      opts.publicDomain,
      ["FRP_PUBLIC_DOMAIN", "PUBLIC_DOMAIN"],
      TUNNEL_CONFIG,
    ),
  );
  if (!publicDomain) return undefined;
  const server = bareHost(config.string(opts.server, "FRP_SERVER")) ?? publicDomain;
  const serverPort = config.port(opts.serverPort, "FRP_SERVER_PORT", 443);
  const protocol = config.string(opts.protocol, "FRP_PROTOCOL") ?? "wss";
  const token = config.string(opts.token, ["FRP_TOKEN", "TUNNEL_TOKEN"]);
  const proxyName =
    config.string(opts.proxyName, "FRP_PROXY_NAME") ?? publicDomain.split(".")[0] ?? "app";
  const appName = config.string(undefined, "DATABRICKS_APP_NAME") ?? proxyName;
  const path = normalizePath(config.string(opts.path, "FRP_PATH") ?? appName);
  const stripPrefix = config.boolean(opts.stripPrefix, "FRP_STRIP_PREFIX") ?? path !== "/";
  return {
    publicDomain,
    server,
    serverPort,
    protocol,
    ...(token ? { token } : {}),
    proxyName,
    path,
    stripPrefix,
    port: opts.port,
    targetPort: opts.targetPort ?? opts.port,
  };
}

/** GitHub release asset name for the current or supplied OS/architecture. */
export function frpAssetName(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const osName = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
  const archName = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : undefined;
  if (!osName || !archName) {
    throw new Error(`frp has no supported release asset for ${platform}/${arch}`);
  }
  return `frp_${version}_${osName}_${archName}.tar.gz`;
}

function frpDownloadUrl(): string {
  const assetName = frpAssetName(FRP_VERSION);
  logger.info("installing frpc", { version: FRP_VERSION, asset: assetName });
  return `${FRP_RELEASE_URL}/${assetName}`;
}

async function selectFrpc(source: string): Promise<string> {
  const path = join(source, frpArchiveDirectory(), "frpc");
  if (process.platform === "darwin") {
    await new Promise<void>((resolve, reject) => {
      const signer = spawn("codesign", ["--force", "--sign", "-", path], { stdio: "ignore" });
      signer.once("error", reject);
      signer.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`codesign exited with code ${code}`)),
      );
    });
  }
  return path;
}

/** Install frpc when absent and return the environment used by its process. */
export async function installFrp(options: FrpInstallOptions = {}): Promise<NodeJS.ProcessEnv> {
  const homeDir = options.homeDir ?? os.homedir();
  const context = await bin.ensure("frpc", frpDownloadUrl, {
    autoUnpackage: true,
    homeDir,
    minVersion: FRP_VERSION,
    selector: ({ source }) => selectFrpc(source),
    versionParser: ({ stdout, stderr }) => {
      const version = bin.parseVersion({ stdout, stderr });
      return version === FRP_VERSION ? version : undefined;
    },
  });
  return {
    ...process.env,
    HOME: homeDir,
    PATH: [context.binDir, process.env.PATH ?? ""].join(delimiter),
  };
}

function frpArchiveDirectory(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return frpAssetName(FRP_VERSION, platform, arch).replace(/\.tar\.gz$/, "");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Render `~/.frpc/frpc.toml` for the resolved tunnel. */
export async function writeFrpConfig(
  resolved: FrpConfig,
  childEnv: NodeJS.ProcessEnv,
): Promise<string> {
  const directory = join(childEnv.HOME ?? os.homedir(), ".frpc");
  const path = join(directory, "frpc.toml");
  await mkdir(directory, { recursive: true });
  const lines = [
    `serverAddr = ${tomlString(resolved.server)}`,
    `serverPort = ${resolved.serverPort}`,
    `transport.protocol = ${tomlString(resolved.protocol)}`,
  ];
  if (resolved.token) lines.push(`auth.token = ${tomlString(resolved.token)}`);
  lines.push(
    "",
    "[[proxies]]",
    `name = ${tomlString(resolved.proxyName)}`,
    'type = "http"',
    `localPort = ${resolved.targetPort}`,
    `customDomains = [${tomlString(resolved.publicDomain)}]`,
    ...(resolved.path === "/" ? [] : [`locations = [${tomlString(resolved.path)}]`]),
    "",
  );
  await writeFile(path, lines.join("\n"));
  return path;
}

/** Launch frpc as a child process (caller supervises and terminates it). */
export function startFrp(
  resolved: FrpConfig,
  childEnv: NodeJS.ProcessEnv,
  configPath: string,
): ReturnType<typeof spawn> {
  logger.info(
    `frpc tunneling https://${resolved.publicDomain}${resolved.path === "/" ? "" : resolved.path} -> :${resolved.port}`,
  );
  return spawn("frpc", ["-c", configPath], { env: childEnv, stdio: "inherit" });
}
