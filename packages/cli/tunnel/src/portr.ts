/**
 * portr install + config + launch for the tunnel CLI.
 *
 * Some hosts (Databricks Apps among them) mount the container's `$HOME` read-only
 * on cold start, so the portr binary and its config are placed under a writable,
 * cwd-rooted `.home` unconditionally - it costs nothing where `$HOME` is writable.
 * The install is idempotent (the installer skips when the on-PATH binary is
 * current). The config is rendered from `PUBLIC_DOMAIN` (`<subdomain>.<server>`)
 * + `PORTR_TOKEN` and points portr at the PUBLIC port (the proxy listens there).
 *
 * @module
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { log } from "@dbx-tools/shared-core";

const logger = log.logger("tunnel:portr");

/** Resolved portr wiring, or `undefined` when no tunnel is configured. */
export interface PortrConfig {
  subdomain: string;
  server: string;
  token: string;
  port: number;
}

/**
 * Resolve portr config from `PUBLIC_DOMAIN` + `PORTR_TOKEN`, or an explicit
 * `subdomain`. `PUBLIC_DOMAIN` is `<subdomain>.<server>` (e.g.
 * `demo.apps.dbx.tools`). Returns `undefined` (no tunnel) when the token or a
 * usable domain is absent.
 */
export function resolvePortrConfig(opts: {
  publicDomain?: string;
  subdomain?: string;
  token?: string;
  port: number;
}): PortrConfig | undefined {
  const token = opts.token ?? process.env.PORTR_TOKEN;
  const domain = opts.publicDomain ?? process.env.PUBLIC_DOMAIN;
  if (!token) return undefined;
  let subdomain = opts.subdomain;
  let server: string | undefined;
  if (domain) {
    subdomain ??= domain.split(".")[0];
    server = domain.slice(domain.indexOf(".") + 1);
  }
  server ??= process.env.PORTR_SERVER;
  if (!subdomain || !server || server === domain) return undefined;
  return { subdomain, server, token, port: opts.port };
}

/** The writable home portr installs + configures under (Apps `$HOME` is read-only). */
function portrHome(): string {
  const home = join(process.cwd(), ".home");
  mkdirSync(join(home, ".portr", "bin"), { recursive: true });
  return home;
}

/** Install portr (idempotent) into the cwd-rooted home and return the child env. */
export function installPortr(): NodeJS.ProcessEnv {
  const home = portrHome();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PORTR_AUTO_ADD_PATH: "no",
    PATH: [join(home, ".portr", "bin"), process.env.PATH ?? ""].join(delimiter),
  };
  logger.info("installing portr (idempotent)");
  const res = spawnSync("bash", ["-c", "curl -sSf https://install.portr.dev | sh"], {
    env,
    stdio: "inherit",
  });
  if (res.status !== 0) throw new Error("portr install failed");
  return env;
}

/** Render `~/.portr/config.yaml` for the resolved tunnel. */
export function writePortrConfig(config: PortrConfig, env: NodeJS.ProcessEnv): void {
  const path = join(env.HOME!, ".portr", "config.yaml");
  writeFileSync(
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
export function startPortr(config: PortrConfig, env: NodeJS.ProcessEnv): ReturnType<typeof spawn> {
  // Reclaim the subdomain from any portr left by a previous boot in this container.
  spawnSync("pkill", ["-x", "portr"], { stdio: "ignore" });
  logger.info(`portr tunneling https://${config.subdomain}.${config.server} -> :${config.port}`);
  return spawn("portr", ["start"], { env, stdio: "inherit" });
}

/** True when the installed portr binary path exists (post-install sanity). */
export function portrInstalled(env: NodeJS.ProcessEnv): boolean {
  return existsSync(join(env.HOME!, ".portr", "bin", "portr"));
}
