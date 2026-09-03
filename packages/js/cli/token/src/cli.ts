/**
 * Commander surface for `dbx token`.
 *
 * @module
 */

import { rm } from "node:fs/promises";
import { exec } from "@dbx-tools/core";
import { error, string } from "@dbx-tools/shared-core";
import { Command, CommanderError, Option } from "commander";

import { clientCredentialMode, createClientToken } from "./auth.ts";
import { TokenBroker } from "./broker.ts";
import { requestAccessToken } from "./client.ts";
import {
  resolveTokenConfig,
  type ContainerEngine,
  type ResolvedTokenConfig,
  type TokenConfigInput,
} from "./config.ts";
import { withBrokerServiceLock } from "./_lock.ts";
import { GoogleTokenProvider } from "./google.ts";
import { resolveBindAddresses } from "./network.ts";
import { getOrCreateSecret, createSecretStore } from "./secrets.ts";
import { manageService, type ServiceAction, type ServiceSpec } from "./service.ts";

type CommonOptions = Omit<
  TokenConfigInput,
  | "allowedHosts"
  | "allowedScopes"
  | "bindDocker"
  | "clientTokenTtlSeconds"
  | "gcloudPath"
  | "providers"
  | "scopes"
> & {
  provider?: string[];
  scope?: string[];
  scopes?: string;
  allowedScope?: string[];
  allowedScopes?: string;
  bindDocker?: string | boolean;
  allowedHost?: string[];
  clientJwtTtlSeconds?: string | number;
  gcloud?: string;
  serviceMode?: boolean;
};

type AccessTokenOptions = Omit<CommonOptions, "auth"> & { auth?: string };

interface BunRuntime {
  which(command: string): string | null;
}

function addCommonOptions(
  command: Command,
  options: { authMode?: boolean; bind?: boolean } = {},
): Command {
  addProviderOptions(command)
    .option("--allowed-scope <scope>", "scope the broker may issue (repeatable)", collect)
    .option("--allowed-scopes <scopes>", "allowed scopes (comma or whitespace separated)")
    .option("--port <port>", "broker port")
    .option("--allowed-host <host>", "allowed HTTP Host header (repeatable)", collect)
    .option("--refresh-skew-seconds <seconds>", "refresh before access-token expiry")
    .option("--access-token-ttl-seconds <seconds>", "conservative provider token lifetime")
    .option("--gcloud <path>", "gcloud executable path");
  addCredentialOptions(command);
  if (options.authMode !== false) {
    command.option("--auth <mode>", "client auth mode: password or jwt");
  }
  if (options.bind) {
    command
      .option("--bind <address>", "address to bind (repeatable)", collect)
      .option(
        "--bind-docker [engine]",
        "add reachable Docker/Podman bridge addresses (auto, docker, or podman)",
      )
      .option("--no-bind-docker", "disable Docker and Podman gateway discovery");
  }
  return command;
}

function addProviderOptions(command: Command): Command {
  return command
    .option("--provider <name>", "enable a token provider (repeatable)", collect)
    .option("--scope <scope>", "provider scope (repeatable)", collect)
    .option("--scopes <scopes>", "provider scopes (comma or whitespace separated)");
}

function addCredentialOptions(command: Command, jwtOnly = false): Command {
  return command
    .option(
      "--secret <secret>",
      jwtOnly ? "JWT HMAC signing secret" : "shared password or JWT HMAC signing secret",
    )
    .option("--state-dir <path>", "broker state directory")
    .option("--client-jwt-ttl-seconds <seconds>", "signed client JWT lifetime")
    .option("--service-name <name>", "native OS service name");
}

function addClientJwtOptions(command: Command): Command {
  return addCredentialOptions(addProviderOptions(command), true);
}

function addAccessTokenOptions(command: Command): Command {
  addProviderOptions(command)
    .option("--server-url <url>", "broker URL")
    .option("--port <port>", "broker port");
  return addCredentialOptions(command);
}

/**
 * Build the lazy-mounted token command tree without starting a server, touching
 * keychain state, or invoking gcloud.
 */
export function buildProgram(name = "dbx token"): Command {
  const program = new Command()
    .name(name)
    .description("Broker short-lived provider access tokens for local development.")
    .showHelpAfterError();

  addCommonOptions(program.command("serve").description("Run the token broker."), {
    bind: true,
  })
    .addOption(new Option("--service-mode").hideHelp())
    .action(async (options: CommonOptions) => {
      const config = resolveOptions(options);
      if (options.serviceMode) {
        await withBrokerServiceLock(config.serviceName, () => serve(config, true));
        return;
      }
      await serve(config, false);
    });

  const service = addCommonOptions(
    program.command("service").description("Manage the native per-user token broker service."),
    { bind: true },
  );
  for (const action of ["install", "remove", "status", "start", "stop"] as const) {
    addCommonOptions(
      service
        .command(action)
        .description(`${string.capitalize(action)} the native token broker service.`),
      { bind: true },
    )
      .option("--purge", "remove broker state after removing the service")
      .action(async (local: { purge?: boolean }, command: Command) => {
        let options = resolveOptions(command.optsWithGlobals() as CommonOptions);
        if (action === "install") {
          if (options.providers.includes("google")) {
            options = {
              ...options,
              gcloudPath: resolveServiceExecutable(options.gcloudPath ?? "gcloud"),
            };
          }
          if (options.auth === "password" && !options.secret) {
            throw new TypeError("Password service installation requires --secret");
          }
          const store = await createSecretStore(options.serviceName, options.stateDir);
          await serviceSecret(options, store);
        }
        const result = await manageService(action as ServiceAction, serviceSpec(options));
        if (action === "remove" && local.purge) {
          await rm(options.stateDir, { recursive: true, force: true });
        }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      });
  }

  addAccessTokenOptions(
    program.command("access-token").description("Print one broker-issued access token."),
  )
    .option("--auth <credential>", "shared password or signed client JWT")
    .option("--client <name>", "JWT client name", "local-cli")
    .action(async (options: AccessTokenOptions) => {
      const { auth: suppliedAuth, ...common } = options;
      const resolved = resolveOptions(common);
      const suppliedCredential =
        string.trimToNull(suppliedAuth) ??
        string.trimToNull(process.env.DBX_TOOLS_TOKEN_BROKER_CLIENT_AUTH) ??
        string.trimToNull(process.env.TOKEN_BROKER_CLIENT_AUTH);
      const auth = suppliedCredential ? clientCredentialMode(suppliedCredential) : resolved.auth;
      const credential =
        suppliedCredential ??
        (await createLocalCredential(resolved, resolved.client, resolved.scopes));
      const accessToken = await requestAccessToken({
        url: brokerUrl(resolved),
        provider: resolved.providers[0],
        scopes: resolved.scopes,
        auth,
        credential,
      });
      process.stdout.write(`${accessToken}\n`);
    });

  addClientJwtOptions(
    program
      .command("client-jwt")
      .description("Create a provider- and scope-constrained client JWT.")
      .argument("[name]", "client identity"),
  ).action(async (client: string | undefined, options: CommonOptions) => {
    const resolved = resolveOptions({ ...options, auth: "jwt" });
    const credential = await createLocalCredential(
      resolved,
      string.trimToNull(client) ?? resolved.client,
      resolved.scopes.length > 0 ? resolved.scopes : resolved.allowedScopes,
    );
    process.stdout.write(`${credential}\n`);
  });

  return program;
}

async function serve(config: ResolvedTokenConfig, serviceMode: boolean): Promise<void> {
  const secret = serviceMode
    ? await serviceSecret(config, await createSecretStore(config.serviceName, config.stateDir))
    : requireSecret(config.secret, "Foreground serve requires --secret");
  const binds = await resolveBindAddresses(config.bind, config.bindDocker);
  const google = new GoogleTokenProvider({
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    executable: config.gcloudPath,
  });
  const broker = new TokenBroker({
    providers: config.providers.includes("google") ? [google] : [],
    defaultProvider: config.providers[0],
    defaultScopes: config.scopes,
    allowedScopes: config.allowedScopes,
    refreshSkewSeconds: config.refreshSkewSeconds,
  });
  const runtimeConfig = { ...config, secret };
  const { startTokenServer } = await import("./server.ts");
  const server = await startTokenServer(broker, runtimeConfig, binds);
  await new Promise<void>((resolve, reject) => {
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    let stopping = false;
    const cleanup = (): void => {
      for (const signal of signals) process.off(signal, stop);
    };
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void server.close().then(
        () => {
          cleanup();
          resolve();
        },
        (cause) => {
          cleanup();
          reject(
            new Error(`token broker shutdown failed: ${error.errorMessage(cause)}`, {
              cause,
            }),
          );
        },
      );
    };
    for (const signal of signals) process.on(signal, stop);
  });
}

async function serviceSecret(
  config: ResolvedTokenConfig,
  store: Awaited<ReturnType<typeof createSecretStore>>,
): Promise<string> {
  const name = config.auth === "password" ? "password" : "jwt-signing";
  if (config.auth === "password" && !config.secret) {
    const stored = await store.get(name);
    if (!stored) throw new TypeError("Stored service password is unavailable");
    return stored;
  }
  return getOrCreateSecret(store, name, config.secret);
}

async function createLocalCredential(
  config: ResolvedTokenConfig,
  client: string,
  scopes: string[],
): Promise<string> {
  const secret = await clientSecret(config);
  if (config.auth === "password") {
    return secret;
  }
  return createClientToken({
    secret,
    client,
    providers: config.providers,
    scopes,
    ttlSeconds: config.clientTokenTtlSeconds,
  });
}

async function clientSecret(config: ResolvedTokenConfig): Promise<string> {
  if (config.secret) return config.secret;
  const store = await createSecretStore(config.serviceName, config.stateDir);
  const name = config.auth === "password" ? "password" : "jwt-signing";
  const stored = await store.get(name);
  if (stored) return stored;
  throw new TypeError("--secret is required when no installed service secret is available");
}

function requireSecret(value: string | undefined, message: string): string {
  const secret = string.trimToNull(value);
  if (!secret) throw new TypeError(message);
  return secret;
}

function resolveOptions(options: CommonOptions): ResolvedTokenConfig {
  const { clientJwtTtlSeconds, gcloud, serviceMode: _serviceMode, ...configOptions } = options;
  const input: TokenConfigInput = {
    ...configOptions,
    clientTokenTtlSeconds: clientJwtTtlSeconds,
    gcloudPath: gcloud,
    providers: options.provider,
    scopes: [...(options.scope ?? []), ...string.parseList(options.scopes)],
    allowedScopes: [...(options.allowedScope ?? []), ...string.parseList(options.allowedScopes)],
    allowedHosts: options.allowedHost,
    bindDocker: normalizeBindDocker(options.bindDocker),
  };
  return resolveTokenConfig(input);
}

function resolveServiceExecutable(command: string): string {
  const fromBun = (globalThis as { Bun?: BunRuntime }).Bun?.which(command);
  if (fromBun) return fromBun;
  const resolver = process.platform === "win32" ? "where.exe" : "/usr/bin/which";
  const result = exec.spawnSync(resolver, [command], {
    stdin: "ignore",
    stdout: "capture",
    stderr: "capture",
    check: false,
  });
  const resolved = result.stdout
    .split(/\r?\n/)
    .map((path) => string.trimToNull(path))
    .find((path): path is string => Boolean(path));
  if (result.exitCode === 0 && resolved) return resolved;
  const detail = string.trimToNull(result.stderr);
  throw new TypeError(
    `Could not resolve ${command} during service installation${detail ? `: ${detail}` : ""}`,
  );
}

function normalizeBindDocker(
  value: string | boolean | undefined,
): ContainerEngine | boolean | undefined {
  if (value === true) return "auto";
  if (value === false || value === undefined) return value;
  return value as ContainerEngine;
}

function brokerUrl(config: ResolvedTokenConfig): string {
  if (config.serverUrl) return config.serverUrl;
  return `http://${config.bind[0]}:${config.port}`;
}

/** Freeze the current dbx entry point and resolved settings into a service spec. */
function serviceSpec(config: ResolvedTokenConfig): ServiceSpec {
  const entry = process.argv[1];
  if (!entry) throw new Error("Could not resolve the dbx CLI entry point");
  return {
    name: config.serviceName,
    description: "dbx-tools local token broker",
    command: process.execPath,
    args: [entry, "token", "serve", ...serviceArgs(config)],
    workingDirectory: config.stateDir,
    stateDirectory: config.stateDir,
  };
}

function serviceArgs(config: ResolvedTokenConfig): string[] {
  return [
    ...config.providers.flatMap((provider) => ["--provider", provider]),
    "--port",
    String(config.port),
    "--auth",
    config.auth,
    "--service-mode",
    "--state-dir",
    config.stateDir,
    "--service-name",
    config.serviceName,
    "--refresh-skew-seconds",
    String(config.refreshSkewSeconds),
    "--access-token-ttl-seconds",
    String(config.accessTokenTtlSeconds),
    "--client-jwt-ttl-seconds",
    String(config.clientTokenTtlSeconds),
    ...(config.gcloudPath ? ["--gcloud", config.gcloudPath] : []),
    ...config.bind.flatMap((bind) => ["--bind", bind]),
    ...(config.bindDocker ? ["--bind-docker", config.bindDocker] : []),
    ...config.scopes.flatMap((scope) => ["--scope", scope]),
    ...config.allowedScopes.flatMap((scope) => ["--allowed-scope", scope]),
    ...config.allowedHosts.flatMap((host) => ["--allowed-host", host]),
  ];
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Parse a process-style argv through the standalone token command. */
export async function runCli(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}

export { CommanderError };
