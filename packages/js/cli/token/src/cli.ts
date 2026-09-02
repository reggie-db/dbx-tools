/**
 * Commander surface for `dbx token`.
 *
 * @module
 */

import { rm } from "node:fs/promises";
import { error, net, object, string } from "@dbx-tools/shared-core";
import { Command, CommanderError } from "commander";

import { createClientToken } from "./auth.ts";
import { TokenBroker } from "./broker.ts";
import { requestAccessToken } from "./client.ts";
import {
  resolveTokenConfig,
  type ContainerEngine,
  type ResolvedTokenConfig,
  type TokenConfigInput,
} from "./config.ts";
import { GoogleTokenProvider } from "./google.ts";
import { resolveBindAddresses } from "./network.ts";
import { getOrCreateSecret, createSecretStore } from "./secrets.ts";
import { manageService, type ServiceAction, type ServiceSpec } from "./service.ts";
import { ensureBrokerTls, ensureClientTls, type TlsPaths } from "./tls.ts";

type CommonOptions = Omit<
  TokenConfigInput,
  "allowedHosts" | "allowedScopes" | "bindDocker" | "caPath" | "certPath" | "keyPath" | "scopes"
> & {
  google?: boolean;
  scope?: string[];
  scopes?: string;
  allowedScope?: string[];
  allowedScopes?: string;
  bindDocker?: string | boolean;
  allowedHost?: string[];
  ca?: string;
  cert?: string;
  key?: string;
};

type AccessTokenOptions = CommonOptions;

interface ClientTokenOptions extends CommonOptions {
  output?: string;
}

function addCommonOptions(command: Command, options: { bind?: boolean } = {}): Command {
  command
    .option("--google", "use Google Application Default Credentials")
    .option("--provider <name>", "token provider")
    .option("--scope <scope>", "provider scope (repeatable)", collect)
    .option("--scopes <scopes>", "provider scopes (comma or whitespace separated)")
    .option("--allowed-scope <scope>", "scope the broker may issue (repeatable)", collect)
    .option("--allowed-scopes <scopes>", "allowed scopes (comma or whitespace separated)")
    .option("--auth <mode>", "client auth: none, password, or jwt")
    .option("--password <password>", "shared client password")
    .option("--signing-secret <secret>", "JWT HMAC secret override")
    .option("--tls <mode>", "transport: mtls or none")
    .option("--state-dir <path>", "broker state directory")
    .option("--server-url <url>", "broker URL used by clients")
    .option("--port <port>", "broker port")
    .option("--allowed-host <host>", "allowed HTTP Host header (repeatable)", collect)
    .option("--refresh-skew-seconds <seconds>", "refresh before access-token expiry")
    .option("--access-token-ttl-seconds <seconds>", "conservative provider token lifetime")
    .option("--client-token-ttl-seconds <seconds>", "signed client-token lifetime")
    .option("--service-name <name>", "native OS service name");
  if (options.bind) {
    command
      .option("--bind <address>", "address to bind (repeatable)", collect)
      .option(
        "--bind-docker [engine]",
        "add reachable Docker/Podman bridge addresses (auto, docker, or podman)",
      );
  }
  return command;
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

  addCommonOptions(
    program.command("serve").description("Run the token broker in the foreground."),
    {
      bind: true,
    },
  ).action(async (options: CommonOptions) => {
    await serve(resolveOptions(options));
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
        const options = resolveOptions(command.optsWithGlobals() as CommonOptions);
        if (action === "install" && options.auth === "none") {
          throw new TypeError("Installed token broker service requires password or jwt auth");
        }
        await prepareSecrets(options, action === "install");
        if (action === "install" && options.tls === "mtls") {
          const binds = await resolveBindAddresses(options.bind, options.bindDocker);
          const store = await createSecretStore(options.serviceName, options.stateDir);
          await ensureBrokerTls(options.stateDir, binds, store);
        }
        const result = await manageService(action as ServiceAction, serviceSpec(options));
        if (action === "remove" && local.purge) {
          await rm(options.stateDir, { recursive: true, force: true });
        }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      });
  }

  addCommonOptions(
    program.command("access-token").description("Print one broker-issued access token."),
  )
    .option("--client <name>", "mTLS/JWT client name", "local-cli")
    .option("--client-token <token>", "signed broker client token")
    .option("--ca <path>", "broker CA certificate")
    .option("--cert <path>", "mTLS client certificate")
    .option("--key <path>", "mTLS client private key")
    .action(async (options: AccessTokenOptions) => {
      const resolved = resolveOptions(options);
      const store = await createSecretStore(resolved.serviceName, resolved.stateDir);
      const client = resolved.client;
      const configuredTls = clientTlsPaths(resolved);
      const tls =
        resolved.tls === "mtls"
          ? (configuredTls ?? (await ensureClientTls(resolved.stateDir, client, store)))
          : undefined;
      let clientToken =
        string.trimToNull(resolved.clientToken) ??
        string.trimToNull(process.env.DBX_TOOLS_TOKEN_BROKER_CLIENT_TOKEN) ??
        string.trimToNull(process.env.TOKEN_BROKER_CLIENT_TOKEN);
      if (resolved.auth === "jwt" && !clientToken) {
        if (!net.isLoopbackHost(brokerUrl(resolved))) {
          throw new TypeError("A client token is required for a non-loopback broker URL");
        }
        const secret = await getOrCreateSecret(store, "jwt-signing", resolved.signingSecret);
        clientToken = await createClientToken({
          secret,
          client,
          providers: [resolved.provider],
          scopes: resolved.allowedScopes,
          ttlSeconds: resolved.clientTokenTtlSeconds,
        });
      }
      const password =
        resolved.auth === "password"
          ? await getOrCreateSecret(store, "password", resolved.password)
          : undefined;
      const accessToken = await requestAccessToken({
        url: brokerUrl(resolved),
        provider: resolved.provider,
        scopes: resolved.scopes,
        auth: resolved.auth,
        ...object.optional("password", password),
        ...object.optional("clientToken", clientToken),
        ...object.optional("tls", tls),
      });
      process.stdout.write(`${accessToken}\n`);
    });

  addCommonOptions(
    program
      .command("client-token")
      .description("Create a client JWT and, when enabled, an mTLS certificate bundle.")
      .argument("<name>", "client identity"),
  )
    .option("--output <directory>", "copy destination for client TLS files")
    .action(async (client: string, options: ClientTokenOptions) => {
      const resolved = resolveOptions({ ...options, auth: "jwt" });
      const store = await createSecretStore(resolved.serviceName, resolved.stateDir);
      const secret = await getOrCreateSecret(store, "jwt-signing", resolved.signingSecret);
      const token = await createClientToken({
        secret,
        client,
        providers: [resolved.provider],
        scopes: resolved.scopes.length > 0 ? resolved.scopes : resolved.allowedScopes,
        ttlSeconds: resolved.clientTokenTtlSeconds,
      });
      if (resolved.tls === "mtls") {
        const paths = await ensureClientTls(resolved.stateDir, client, store, options.output);
        process.stderr.write(`client mTLS bundle: ${JSON.stringify(paths)}\n`);
      }
      process.stdout.write(`${token}\n`);
    });

  return program;
}

async function serve(config: ResolvedTokenConfig): Promise<void> {
  const binds = await resolveBindAddresses(config.bind, config.bindDocker);
  const store = await createSecretStore(config.serviceName, config.stateDir);
  const secrets = await prepareSecrets(config, true, store);
  const provider = new GoogleTokenProvider({
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
  });
  const broker = new TokenBroker({
    providers: [provider],
    defaultProvider: config.provider,
    defaultScopes: config.scopes,
    allowedScopes: config.allowedScopes,
    refreshSkewSeconds: config.refreshSkewSeconds,
  });
  const tls =
    config.tls === "mtls" ? await ensureBrokerTls(config.stateDir, binds, store) : undefined;
  const runtimeConfig = {
    ...config,
    ...object.optional("password", secrets.password),
    ...object.optional("signingSecret", secrets.signingSecret),
  };
  const { startTokenServer } = await import("./server.ts");
  const server = await startTokenServer(broker, runtimeConfig, binds, tls);
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void server
      .close()
      .then(() => process.exit(0))
      .catch((cause) => {
        process.stderr.write(`token broker shutdown failed: ${error.errorMessage(cause)}\n`);
        process.exit(1);
      });
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
}

async function prepareSecrets(
  config: ResolvedTokenConfig,
  create: boolean,
  existingStore?: Awaited<ReturnType<typeof createSecretStore>>,
): Promise<{ password?: string; signingSecret?: string }> {
  const store = existingStore ?? (await createSecretStore(config.serviceName, config.stateDir));
  if (config.auth === "password") {
    if (!create && !config.password) return {};
    return { password: await getOrCreateSecret(store, "password", config.password) };
  }
  if (config.auth === "jwt") {
    if (!create && !config.signingSecret) return {};
    return {
      signingSecret: await getOrCreateSecret(store, "jwt-signing", config.signingSecret),
    };
  }
  return {};
}

function resolveOptions(options: CommonOptions): ResolvedTokenConfig {
  const input: TokenConfigInput = {
    ...options,
    ...(options.google ? { provider: "google" } : {}),
    scopes: [...(options.scope ?? []), ...string.parseList(options.scopes)],
    allowedScopes: [...(options.allowedScope ?? []), ...string.parseList(options.allowedScopes)],
    allowedHosts: options.allowedHost,
    bindDocker: normalizeBindDocker(options.bindDocker),
    caPath: options.ca,
    certPath: options.cert,
    keyPath: options.key,
  };
  return resolveTokenConfig(input);
}

/** Use an explicit client bundle only when all three paths are present. */
function clientTlsPaths(config: ResolvedTokenConfig): TlsPaths | undefined {
  const { caPath: ca, certPath: cert, keyPath: key } = config;
  if (ca && cert && key) return { ca, cert, key };
  if (ca || cert || key) throw new TypeError("--ca, --cert, and --key must be provided together");
  return undefined;
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
  const scheme = config.tls === "mtls" ? "https" : "http";
  const host = config.bind[0] === "0.0.0.0" ? "127.0.0.1" : config.bind[0];
  return `${scheme}://${host}:${config.port}`;
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
    "--provider",
    config.provider,
    "--port",
    String(config.port),
    "--auth",
    config.auth,
    "--tls",
    config.tls,
    "--state-dir",
    config.stateDir,
    "--service-name",
    config.serviceName,
    "--refresh-skew-seconds",
    String(config.refreshSkewSeconds),
    "--access-token-ttl-seconds",
    String(config.accessTokenTtlSeconds),
    "--client-token-ttl-seconds",
    String(config.clientTokenTtlSeconds),
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
