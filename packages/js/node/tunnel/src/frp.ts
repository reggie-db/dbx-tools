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

import {
  AppKitChildProcess,
  type AppKitChildProcessOptions,
} from "@dbx-tools/appkit/child-process";
import { bin, configUtils } from "@dbx-tools/core";
import { log, options as sharedOptions } from "@dbx-tools/shared-core";
import { z } from "zod";
import { TUNNEL_CONFIG } from "./_config.ts";
import { superviseProcessForever, type ProcessSupervisor } from "./supervisor.ts";

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

export const FrpOptionsSchema = z
  .object({
    publicDomain: z.string().trim().min(1).optional().describe("FRP public HTTP host."),
    server: z.string().trim().min(1).optional().describe("FRP control host."),
    serverPort: sharedOptions.tcpPortOrZeroSchema.optional().describe("FRP control port."),
    protocol: z.string().trim().min(1).optional().describe("FRP transport protocol."),
    token: z.string().trim().min(1).optional().describe("FRP authentication token."),
    proxyName: z.string().trim().min(1).optional().describe("FRP proxy registration name."),
    path: z.string().trim().min(1).optional().describe("FRP public path."),
    stripPrefix: z.boolean().optional().describe("Strip the FRP path before forwarding."),
    port: sharedOptions.tcpPortOrZeroSchema.describe("Public listener port."),
    targetPort: sharedOptions.tcpPortOrZeroSchema.optional().describe("Private target port."),
  })
  .strict()
  .describe("FRP tunnel resolution options.");

export type FrpOptions = z.input<typeof FrpOptionsSchema>;

function bareHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    ?.trim();
  return normalized || undefined;
}

function normalizePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

/** Resolve frpc config from the public domain and FRP-specific environment. */
export function resolveFrpConfig(opts: FrpOptions): FrpConfig | undefined {
  const options = FrpOptionsSchema.parse(opts);
  const publicDomain = bareHost(
    configUtils.string(
      options.publicDomain,
      ["TUNNEL_FRP_PUBLIC_DOMAIN", "TUNNEL_PUBLIC_DOMAIN"],
      TUNNEL_CONFIG,
    ),
  );
  if (!publicDomain) return undefined;
  const server = bareHost(configUtils.string(options.server, "FRP_SERVER")) ?? publicDomain;
  const serverPort = configUtils.port(options.serverPort, "FRP_SERVER_PORT", 443);
  const protocol = configUtils.string(options.protocol, "FRP_PROTOCOL") ?? "wss";
  const token = configUtils.string(options.token, ["FRP_TOKEN", "TUNNEL_TOKEN"]);
  const proxyName =
    configUtils.string(options.proxyName, "FRP_PROXY_NAME") ?? publicDomain.split(".")[0] ?? "app";
  const appName = configUtils.string(undefined, "DATABRICKS_APP_NAME") ?? proxyName;
  const path = normalizePath(configUtils.string(options.path, "FRP_PATH") ?? appName);
  const stripPrefix = configUtils.boolean(options.stripPrefix, "FRP_STRIP_PREFIX") ?? path !== "/";
  return {
    publicDomain,
    server,
    serverPort,
    protocol,
    ...(token ? { token } : {}),
    proxyName,
    path,
    stripPrefix,
    port: options.port,
    targetPort: options.targetPort ?? options.port,
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
    "loginFailExit = false",
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
  options: AppKitChildProcessOptions = {},
): AppKitChildProcess {
  logger.info(
    `frpc tunneling https://${resolved.publicDomain}${resolved.path === "/" ? "" : resolved.path} -> :${resolved.port}`,
  );
  const child = new AppKitChildProcess(
    [
      "frpc",
      ["-c", configPath],
      { env: childEnv, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    ],
    options,
  );
  child.start();
  return child;
}

/** Supervise the FRP client for a resolved tunnel configuration. */
export function superviseFrp(
  resolved: FrpConfig,
  childEnv: NodeJS.ProcessEnv,
  configPath: string,
): ProcessSupervisor {
  return superviseProcessForever({
    name: "frpc",
    logger,
    start: () => startFrp(resolved, childEnv, configPath, { gracefulTimeoutMs: 10_000 }),
  });
}
