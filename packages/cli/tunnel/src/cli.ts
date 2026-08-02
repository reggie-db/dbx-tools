/**
 * `dbx-tools-tunnel` / `dbxt-tunnel` CLI.
 *
 * Wraps an app's start command with a public portr tunnel and an email-OTP
 * access gate. Everything after `--` is the REAL app start command:
 *
 *   dbxt-tunnel --subject "Here's your OTP" --allow example.com -- bun src/server.ts
 *
 * Boot sequence:
 *   1. Pick a random PRIVATE port and spawn the app command with
 *      `DATABRICKS_APP_PORT` set to it (so the app binds loopback-private). That
 *      variable name is the Databricks Apps runtime contract; the gate itself is
 *      platform-neutral and honours whatever port it finds there.
 *   2. Boot the tiny gate AppKit app (no server): inits `CacheManager` + the
 *      email transport, yields the in-process gate API.
 *   3. Start the gate PROXY on the ORIGINAL public port, forwarding to the app.
 *   4. Install + run portr pointed at the public port (when a tunnel is
 *      configured; otherwise the proxy still gates nothing and forwards).
 *
 * Supervision: the app child, portr child, and this process are tied together -
 * if ANY exits, everything comes down (concurrently-style `killOthers`).
 *
 * Options come from flags OR env; see the option definitions below.
 *
 * @module
 */

import { type ChildProcess, spawn } from "node:child_process";
import { env, log } from "@dbx-tools/shared-core";
import { Command, CommanderError } from "commander";
import { startGateApp } from "./app.ts";
import { FORWARD_HEADERS_ENV, INSECURE_ENV } from "./env.ts";
import type { AuthGateConfig } from "./plugin.ts";
import { installPortr, resolvePortrConfig, startPortr, writePortrConfig } from "./portr.ts";
import { startProxy } from "./proxy.ts";

export { CommanderError };

const logger = log.logger("tunnel");

/** A random ephemeral port for the app to bind (the proxy fronts the public one). */
function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

interface TunnelOpts {
  subject?: string;
  allow?: string;
  subdomain?: string;
  publicDomain?: string;
  brandName?: string;
  message?: string;
  sessionTtl?: string;
  codeTtl?: string;
  sessionCutoff?: string;
  insecure?: boolean;
  forwardHeaders?: string;
}

/** Build the commander program. `--` separates flags from the app start command. */
function program(): Command {
  return new Command()
    .name("dbx-tools-tunnel")
    .description("Front an app with a public portr tunnel + email-OTP gate")
    .option("--subject <text>", "Subject line for the code email (env TUNNEL_AUTH_SUBJECT)")
    .option(
      "--allow <patterns>",
      "Comma/space-separated allow-list: domain / glob / /regex/ (env TUNNEL_AUTH_ALLOW)",
    )
    .option("--subdomain <name>", "portr subdomain (else derived from TUNNEL_PUBLIC_DOMAIN)")
    .option("--public-domain <host>", "portr <subdomain>.<server> (env TUNNEL_PUBLIC_DOMAIN)")
    .option(
      "--brand-name <name>",
      "Display name in the code email copy (env TUNNEL_AUTH_BRAND_NAME; defaults to the brand context name)",
    )
    .option("--message <text>", "Line shown above the code in the email (env TUNNEL_AUTH_MESSAGE)")
    .option("--session-ttl <seconds>", "Session lifetime (env TUNNEL_AUTH_SESSION_TTL)")
    .option("--code-ttl <seconds>", "One-time-code lifetime (env TUNNEL_AUTH_CODE_TTL)")
    .option(
      "--session-cutoff <when>",
      "Invalidate sessions issued before this point, signing everyone out: a date, ISO instant, epoch seconds, or relative duration like -30d (env TUNNEL_AUTH_SESSION_CUTOFF)",
    )
    .option(
      "--forward-headers <patterns>",
      "Extra x- request headers tunnel traffic may forward: literal / glob / /regex/ (env TUNNEL_FORWARD_HEADERS)",
    )
    .option(
      "--insecure",
      "Run the tunnel OPEN with no gate (env TUNNEL_INSECURE=true). Otherwise the CLI fails fast when email SMTP is not configured.",
    )
    .allowExcessArguments(true)
    .helpOption("-h, --help", "Show help");
}

/** Tie a child's exit to full teardown: any exit brings the whole tunnel down. */
function superviseExit(children: ChildProcess[]): void {
  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) child.kill("SIGTERM");
    }
    // Give children a moment, then exit with the first non-zero code seen.
    setTimeout(() => process.exit(code), 3000).unref();
  };
  for (const child of children) {
    child.on("exit", (code) => {
      logger.warn(`child exited (${code ?? "signal"}); bringing tunnel down`);
      shutdown(code ?? 1);
    });
  }
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => shutdown(0));
  }
}

/** Parse argv and run the tunnel. */
export async function runCli(argv: string[]): Promise<void> {
  // Split flags from the wrapped command at the first `--`.
  const sep = argv.indexOf("--");
  const flags = sep >= 0 ? argv.slice(0, sep) : argv;
  const command = sep >= 0 ? argv.slice(sep + 1) : [];

  const prog = program();
  prog.parse(flags);
  const opts = prog.opts<TunnelOpts>();

  if (command.length === 0) {
    throw new CommanderError(1, "tunnel.no-command", "no start command given after `--`");
  }

  const publicPort = Number(process.env.DATABRICKS_APP_PORT ?? 8000);
  const appPort = randomPort();

  const gateConfig: AuthGateConfig = {
    allow: opts.allow,
    subject: opts.subject,
    brandName: opts.brandName,
    message: opts.message,
    sessionTtlSeconds: opts.sessionTtl ? Number(opts.sessionTtl) : undefined,
    codeTtlSeconds: opts.codeTtl ? Number(opts.codeTtl) : undefined,
    sessionCutoff: opts.sessionCutoff,
    // Also given to portr below; the gate uses it only to bind the emailed code
    // to this host for Apple's AutoFill.
    publicDomain: opts.publicDomain,
  };

  // 1. Spawn the wrapped app with the PRIVATE port. It binds loopback; only the
  //    proxy reaches it.
  logger.info(`spawning app on private port ${appPort}: ${command.join(" ")}`);
  const [cmd, ...args] = command;
  const app = spawn(cmd!, args, {
    env: { ...process.env, DATABRICKS_APP_PORT: String(appPort), HOST: "127.0.0.1" },
    stdio: "inherit",
  });

  // 2. Boot the gate app (cache + email transport + gate API). `startGateApp`
  //    FAILS FAST when email can't send codes (no SMTP). Insecure mode
  //    (`--insecure` / TUNNEL_INSECURE) skips the gate and runs the tunnel open.
  const insecure = env.boolean(opts.insecure, INSECURE_ENV) ?? false;
  let gate: Awaited<ReturnType<typeof startGateApp>> | undefined;
  if (insecure) {
    logger.warn("insecure mode - tunnel runs OPEN with no email-OTP gate");
  } else {
    try {
      gate = await startGateApp(gateConfig);
    } catch (error) {
      // Fail fast: don't silently expose an ungated tunnel. The operator must fix
      // SMTP or explicitly opt into `--insecure`.
      logger.error("cannot start the OTP gate", { error: (error as Error).message });
      throw error;
    }
  }

  // 3. Start the gate proxy on the public port (open when `gate` is undefined).
  //    `forwardHeaders` only ADDS to the built-in allow-list; see `./headers.ts`.
  await startProxy({
    publicPort,
    appPort,
    gate,
    forwardHeaders: env.list(opts.forwardHeaders, FORWARD_HEADERS_ENV),
  });

  // 4. Install + run portr when a tunnel is configured.
  const portrConfig = resolvePortrConfig({
    publicDomain: opts.publicDomain,
    subdomain: opts.subdomain,
    port: publicPort,
  });
  const children: ChildProcess[] = [app];
  if (portrConfig) {
    const portrEnv = installPortr();
    writePortrConfig(portrConfig, portrEnv);
    children.push(startPortr(portrConfig, portrEnv));
  } else {
    logger.info(
      "no PORTR_TOKEN/TUNNEL_PUBLIC_DOMAIN - serving the gate proxy without a public tunnel",
    );
  }

  // Any child exit (or a signal) tears the whole thing down.
  superviseExit(children);
}
