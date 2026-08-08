/**
 * `dbx tunnel` - front a command with a public portr tunnel and passwordless gate.
 *
 * This is the WRAPPER path, and it exists for one case: a project that does not
 * use `@dbx-tools/appkit`'s `createApp`, and therefore cannot register
 * `tunnelInterceptor()` + the `authGate` plugin in-process. An AppKit app should
 * still take the plugin path - one process, no proxy hop, no duplicated header
 * handling.
 *
 * The wrapper claims the PUBLIC port (`DATABRICKS_APP_PORT`, the port the
 * platform and portr route to), moves the wrapped app to a private one, and
 * reverse-proxies between them so the gate sits in front of traffic it would
 * otherwise have no way to intercept. Everything else is delegated: the gate
 * config comes from `plugin.resolveAuthGateConfig`, the portr lifecycle from
 * `portr.*` - both the same functions the in-process path uses.
 *
 * Ships no bin. `@dbx-tools/cli` mounts `buildProgram()` as `dbx tunnel` lazily,
 * so `dbx dev` pays for none of this, and `--insecure` / `status` / `install`
 * never load AppKit or the SMTP stack either (the gate app is behind a dynamic
 * import).
 *
 * @module
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { log } from "@dbx-tools/shared-core";
import { portr } from "@dbx-tools/tunnel";
import { Command, CommanderError } from "commander";
import { resolveTunnelOptions, type TunnelOptions } from "./options.ts";
import { startProxy } from "./proxy.ts";

export { CommanderError };

const logger = log.logger("tunnel");

/** How long a child gets to exit on SIGTERM before the wrapper leaves anyway. */
const SHUTDOWN_GRACE_MS = 3_000;

/**
 * A free loopback port, from the OS rather than a random guess: binding `0` and
 * reading back what was assigned is the only way to know the port is actually
 * available, so two tunnels can run side by side without colliding.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * Every gate/portr flag. Declared on the root command AND on `run`/`status` so
 * `dbx tunnel --allow x -- cmd` and `dbx tunnel run --allow x -- cmd` behave
 * identically - commander does not inherit options downward.
 */
function addOptions(command: Command): Command {
  return command
    .option("--public-domain <host>", "portr public domain (<subdomain>.<server>)")
    .option("--subdomain <name>", "portr subdomain (else derived from the public domain)")
    .option("--port <port>", "public port the wrapper listens on")
    .option("--app-port <port>", "private port the wrapped app is told to bind")
    .option("--allow <patterns...>", "email allow-list (domain / glob / /regex/)")
    .option("--subject <text>", "verification email subject")
    .option("--brand-name <name>", "verification email brand name")
    .option("--message <text>", "verification email message")
    .option("--session-ttl <seconds>", "session lifetime")
    .option("--code-ttl <seconds>", "one-time-code lifetime")
    .option("--session-cutoff <when>", "invalidate every session issued before this")
    .option("--auth-storage <mode>", "auth database: auto, lakebase, or sqlite")
    .option("--auth-sqlite-path <path>", "local Better Auth SQLite file")
    .option("--forward-headers <patterns...>", "extra x- headers tunnel traffic may forward")
    .option("--bind <host...>", "interface IPs the gate listens on (default: 0.0.0.0)")
    .option("--insecure", "run open, with no gate");
}

/**
 * Tie the wrapper's lifetime to its children's, in both directions: a child that
 * exits takes the wrapper down with its code, and a signal to the wrapper is
 * forwarded before it leaves. Without this a crashed app leaves a portr tunnel
 * serving a dead port, which looks like a hang rather than a failure.
 */
function supervise(children: readonly ChildProcess[]): void {
  let stopping = false;
  const stop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (!child.killed) child.kill("SIGTERM");
    setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS).unref();
  };
  for (const child of children) child.on("exit", (code) => stop(code ?? 1));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => stop(0));
  }
}

async function run(raw: TunnelOptions, command: readonly string[]): Promise<void> {
  const [executable, ...args] = command;
  const resolved = resolveTunnelOptions(raw);
  const children: ChildProcess[] = [];

  // Two upstream modes:
  //   - WRAP: a command after `--`. The wrapper spawns it on a private loopback
  //     port and is the only thing that talks to it.
  //   - ATTACH: no command, but `--app-port` names an already-running upstream
  //     (e.g. a local reverse proxy). The gate fronts it without spawning a
  //     child. This is what lets the gate sit on an interface in front of a
  //     separately-supervised stack.
  let appPort: number;
  if (executable) {
    appPort = resolved.appPort ?? (await freePort());
    const app = spawn(executable, args, {
      env: {
        ...process.env,
        DATABRICKS_APP_PORT: String(appPort),
        PORT: String(appPort),
        HOST: "127.0.0.1",
      },
      stdio: "inherit",
    });
    children.push(app);
  } else if (resolved.appPort) {
    appPort = resolved.appPort;
    logger.info("attaching gate to existing upstream", { appPort });
  } else {
    throw new CommanderError(
      1,
      "tunnel.no-upstream",
      "no command given (pass it after `--`) and no --app-port to attach to",
    );
  }

  // Dynamic import: the gate is the only thing here that needs AppKit + SMTP, so
  // an `--insecure` run never loads either.
  const gate = resolved.gate.insecure
    ? undefined
    : await (
        await import("./app.ts")
      ).startGateApp({
        ...resolved.gateConfig,
        publicDomain: resolved.gate.publicDomain ?? `localhost:${resolved.publicPort}`,
      });
  if (!gate) logger.warn("running OPEN - no gate is in front of this tunnel");

  await startProxy({
    publicPort: resolved.publicPort,
    appPort,
    gate,
    forwardHeaders: resolved.gate.forwardHeaders,
    bindHosts: resolved.bindHosts,
  });

  if (resolved.portr) {
    const portrEnv = await portr.installPortr();
    await portr.writePortrConfig(resolved.portr, portrEnv);
    children.push(await portr.startPortr(resolved.portr, portrEnv));
  } else {
    logger.info("no PORTR_TOKEN / TUNNEL_PUBLIC_DOMAIN - serving locally only", {
      publicPort: resolved.publicPort,
    });
  }
  supervise(children);
}

/** The `dbx tunnel` program. No side effects until parsed. */
export function buildProgram(name = "dbx tunnel"): Command {
  const program = addOptions(
    new Command()
      .name(name)
      .description("Front a command with a portr tunnel and passwordless auth"),
  );

  // `run` is the DEFAULT action as well as a named subcommand, preserving the old
  // wrapper's ergonomics (`dbx tunnel --allow x -- bun src/server.ts`) while
  // leaving somewhere for `status` and `install` to live.
  program
    .argument("[command...]", "the command to wrap, after `--`")
    .action(async (command: string[], _options: TunnelOptions, cmd: Command) => {
      await run(cmd.opts<TunnelOptions>(), command);
    });

  addOptions(program.command("run").description("Wrap a command (the default action)"))
    .argument("<command...>", "the command to wrap, after `--`")
    .action(async (command: string[], _options: TunnelOptions, cmd: Command) => {
      await run(cmd.opts<TunnelOptions>(), command);
    });

  // Worth its own command: the most common failure is a tunnel that silently
  // does nothing because no token or domain resolved, and this prints exactly
  // what would happen without starting anything.
  addOptions(
    program.command("status").description("Resolve the configuration and print it"),
  ).action((_options: TunnelOptions, cmd: Command) => {
    const resolved = resolveTunnelOptions(cmd.opts<TunnelOptions>());
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  });

  program
    .command("install")
    .description("Install the portr binary and exit")
    .action(async () => {
      await portr.installPortr();
    });

  return program;
}
