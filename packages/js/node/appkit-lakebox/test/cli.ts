/**
 * Interactive Lakebox harness for arbitrary user identities.
 *
 * Runs the real {@link LakeboxRuntime} against a workspace profile, acting as
 * any `--user` identity, so multi-user behavior can be exercised without an
 * AppKit deployment. Lakebox lifecycle calls use the profile identity in place
 * of the app service principal. `serve` mounts the deterministic route proxy on
 * loopback and injects the chosen identity, so terminals, desktops, and
 * services open in a local browser.
 *
 * Usage:
 *   bun test/cli.ts --profile <name> [--user <identity>] [--application <name>]
 *     [--idle-timeout <seconds>] <command>
 *
 * Run `serve` under Node (`bunx tsx test/cli.ts ... serve`): Bun's node:http
 * upgrade sockets do not carry proxied WebSocket traffic, while AppKit runs on
 * Node.
 *
 * Commands:
 *   status | start | stop | delete
 *   exec <command> [args...]
 *   service list | create <json> | start <name> | stop <name> | remove <name> | logs <name>
 *   serve [--port <port>]          start terminal and desktop, then proxy routes locally
 *   metrics [--samples <count>]
 */

import { createServer } from "node:http";
import type { Socket } from "node:net";
import { parseArgs } from "node:util";
import { CacheManager } from "@databricks/appkit";
import { client as authClient } from "@dbx-tools/auth";
import express from "express";
import { LakeboxResourceRegistry } from "../src/_resource-registry.ts";
import { resolveLakeboxPluginConfig } from "../src/config.ts";
import { LakeboxRuntime } from "../src/runtime.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: "string" },
    user: { type: "string", default: "lakebox-cli@example.com" },
    application: { type: "string", default: "lakebox-cli" },
    port: { type: "string", default: "8787" },
    samples: { type: "string", default: "3" },
    "idle-timeout": { type: "string", default: "900" },
  },
});

if (!values.profile) {
  console.error("--profile is required; pass the explicit Databricks CLI profile to test with");
  process.exit(2);
}

const auth = await authClient.createAuthClient({ profile: values.profile });
const identity = values.user;
const runtime = new LakeboxRuntime(
  resolveLakeboxPluginConfig({
    application: values.application,
    idleTimeoutSeconds: Number(values["idle-timeout"]),
  }),
);
await CacheManager.getInstance();
runtime.initialize(
  {
    host: auth.host,
    ...(auth.workspaceId ? { workspaceId: auth.workspaceId } : {}),
    authenticate: async (headers) => {
      for (const [name, value] of Object.entries(await auth.headers())) headers.set(name, value);
    },
  },
  () => identity,
  undefined,
  new LakeboxResourceRegistry(runtime.config.application),
);

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const [command, ...rest] = positionals;

try {
  switch (command) {
    case "status":
      print(await runtime.summary(identity));
      break;
    case "start":
      await runtime.start();
      print(await runtime.summary(identity));
      break;
    case "stop":
      await runtime.stop();
      print(await runtime.summary(identity));
      break;
    case "delete":
      print({ deleted: await runtime.delete() });
      break;
    case "exec": {
      const [executable, ...args] = rest;
      if (!executable) throw new Error("exec requires a command");
      const execution = runtime.execute(identity, { command: executable, args });
      execution.stdout.pipe(process.stdout);
      execution.stderr.pipe(process.stderr);
      process.exitCode = await execution;
      break;
    }
    case "service":
      await service(rest);
      break;
    case "serve":
      await serve(Number(values.port));
      break;
    case "metrics":
      await metrics(Number(values.samples));
      break;
    default:
      console.error(
        "usage: cli.ts --profile <name> [--user <identity>] status|start|stop|delete|exec|service|serve|metrics",
      );
      process.exitCode = 2;
  }
} finally {
  if (command !== "serve") await runtime.close();
}

async function service([action, argument]: string[]): Promise<void> {
  switch (action) {
    case "list":
      return print(await runtime.listServices(identity));
    case "create":
      return print(await runtime.createService(identity, JSON.parse(argument ?? "{}")));
    case "start":
      return print(await runtime.startService(identity, required(argument)));
    case "stop":
      return print(await runtime.stopService(identity, required(argument)));
    case "remove":
      return print({ removed: await runtime.removeService(identity, required(argument)) });
    case "logs":
      return console.log((await runtime.serviceLogs(identity, { name: required(argument) })).log);
    default:
      throw new Error("service requires list, create, start, stop, remove, or logs");
  }
}

async function serve(port: number): Promise<void> {
  const application = express();
  application.use(runtime.routes.middleware());
  const server = createServer(application);
  server.on("upgrade", (request, socket, head) => {
    void runtime.routes.handleUpgrade(request, socket as Socket, head).then((handled) => {
      if (!handled) socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const user = runtime.user(identity);
  console.log(`Proxying ${user.name} routes on http://127.0.0.1:${port}${user.routePrefix}/`);
  for (const name of ["terminal", "desktop"]) {
    const started = await runtime.startService(identity, name);
    console.log(`${name}: ${started.state} http://127.0.0.1:${port}${started.openUrl ?? ""}`);
    if (started.error) console.log(`  ${started.error}`);
  }
  process.once("SIGINT", () => {
    server.close();
    void runtime.close().then(() => process.exit(0));
  });
}

async function metrics(samples: number): Promise<void> {
  await runtime.start();
  await new Promise<void>((resolve) => {
    let seen = 0;
    const unsubscribe = runtime.subscribeMetrics((snapshot) => {
      print(snapshot);
      seen += 1;
      if (seen >= samples) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function required(value: string | undefined): string {
  if (!value) throw new Error("A service name is required");
  return value;
}
