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

import { createServer } from "node:net";
import { AppKitChildProcess } from "@dbx-tools/appkit/child-process";
import { addArgs, parseArgs } from "@dbx-tools/cli-args/args";
import { log } from "@dbx-tools/shared-core";
import { frp, interceptor, portr } from "@dbx-tools/tunnel";
import { Command, CommanderError } from "commander";
import { resolveTunnelOptions, TunnelOptionsSchema, type TunnelOptions } from "./options.ts";
import { startProxy } from "./proxy.ts";

export { CommanderError };

const logger = log.logger("tunnel");

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
 * Tie the wrapper's lifetime to its children's, in both directions: a child that
 * exits takes the wrapper down with its code, and a signal to the wrapper is
 * forwarded before it leaves. Without this a crashed app leaves a portr tunnel
 * serving a dead port, which looks like a hang rather than a failure.
 */
function supervise(children: readonly AppKitChildProcess[]): void {
  let stopping = false;
  const stop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    void Promise.allSettled(children.map((child) => child.shutdown())).then(() => process.exit(code));
  };
  for (const child of children) child.process?.on("exit", (code) => stop(code ?? 1));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => stop(0));
  }
}

async function run(raw: TunnelOptions, command: readonly string[]): Promise<void> {
  const [executable, ...args] = command;
  const resolved = resolveTunnelOptions(raw);
  const children: AppKitChildProcess[] = [];

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
    const app = new AppKitChildProcess(
      [
        executable,
        args,
        {
          env: {
            ...process.env,
            DATABRICKS_APP_PORT: String(appPort),
            PORT: String(appPort),
            HOST: "127.0.0.1",
          },
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        },
      ],
      { gracefulTimeoutMs: 10_000 },
    );
    app.start();
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
    gatePaths: resolved.gate.gatePaths,
    brandName: resolved.gate.brandName,
    bindHosts: resolved.bindHosts,
  });

  if ((resolved.transport === "portr" || resolved.transport === "both") && resolved.portr) {
    const portrEnv = await portr.installPortr();
    await portr.writePortrConfig(resolved.portr, portrEnv);
    children.push(await portr.startPortr(resolved.portr, portrEnv));
  }
  if ((resolved.transport === "frp" || resolved.transport === "both") && resolved.frp) {
    const frpEnv = await frp.installFrp();
    const configPath = await frp.writeFrpConfig(resolved.frp, frpEnv);
    children.push(frp.startFrp(resolved.frp, frpEnv, configPath));
  }
  const activeTunnelCount = children.length - (executable ? 1 : 0);
  if (!activeTunnelCount) {
    logger.info("no selected public tunnel is configured", {
      transport: resolved.transport,
      publicPort: resolved.publicPort,
    });
  }
  supervise(children);
}

/** The `dbx tunnel` program. No side effects until parsed. */
export function buildProgram(name = "dbx tunnel"): Command {
  const program = addArgs(
    new Command()
      .name(name)
      .description("Front a command with a public tunnel and passwordless auth"),
    TunnelOptionsSchema,
  );

  // `run` is the DEFAULT action as well as a named subcommand, preserving the old
  // wrapper's ergonomics (`dbx tunnel --allow x -- bun src/server.ts`) while
  // leaving somewhere for `status` and `install` to live.
  program
    .argument("[command...]", "the command to wrap, after `--`")
    .action(async (command: string[]) => {
      await run(parseArgs(program, TunnelOptionsSchema), command);
    });

  const runCommand = addArgs(
    program.command("run").description("Wrap a command (the default action)"),
    TunnelOptionsSchema,
  );
  runCommand
    .argument("<command...>", "the command to wrap, after `--`")
    .action(async (command: string[]) => {
      await run(parseArgs(runCommand, TunnelOptionsSchema), command);
    });

  // Worth its own command: the most common failure is a tunnel that silently
  // does nothing because no token or domain resolved, and this prints exactly
  // what would happen without starting anything.
  const statusCommand = addArgs(
    program.command("status").description("Resolve the configuration and print it"),
    TunnelOptionsSchema,
  );
  statusCommand.action(() => {
    const resolved = resolveTunnelOptions(parseArgs(statusCommand, TunnelOptionsSchema));
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  });

  program
    .command("install")
    .argument("[transport]", "portr, frp, or both", "portr")
    .description("Install public tunnel client binaries and exit")
    .action(async (transport: string) => {
      const parsed = interceptor.TunnelTransportSchema.parse(transport);
      if (parsed === "portr" || parsed === "both") await portr.installPortr();
      if (parsed === "frp" || parsed === "both") await frp.installFrp();
    });

  return program;
}
