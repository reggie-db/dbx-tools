/**
 * `dbx auth` Commander program for Databricks OAuth.
 *
 * The command delegates profile resolution, browser OAuth, token refresh,
 * locking, and credential storage to `@dbx-tools/databricks-auth`.
 *
 * @module
 */

import * as auth from "@dbx-tools/auth";
import * as databricksAuth from "@dbx-tools/databricks-auth";
import { string as sharedString } from "@dbx-tools/shared-core";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

type StorageName = "auto" | "memory" | "file";

interface AuthCliOptions {
  profile?: string;
  host?: string;
  accountId?: string;
  workspaceId?: string;
  configFile?: string;
  clientId?: string;
  groupId?: string;
  authType?: string;
  scopes?: string[];
  target?: string;
  storage: StorageName;
  cacheDir?: string;
  callbackImageSrc?: string;
  lockTimeoutSeconds: string;
  loginTimeoutSeconds: string;
  refreshBufferSeconds: string;
  preferUserToMachine: boolean;
}

interface TokenCommandOptions {
  forceRefresh?: boolean;
  loginIfMissing?: boolean;
}

interface AuthContext {
  auth: databricksAuth.PersistentAuthLike;
  close(): Promise<void>;
  storage?: StorageName;
}

interface AuthCliDependencies {
  createPersistentAuth: typeof databricksAuth.createPersistentAuth;
  writeJson(value: unknown): void;
}

const DEFAULT_DEPENDENCIES: AuthCliDependencies = {
  createPersistentAuth: databricksAuth.createPersistentAuth,
  writeJson: (value) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  },
};

/** Collect comma-separated and repeated scope values into one ordered list. */
function collectScopes(value: string, previous: string[] = []): string[] {
  return [...previous, ...sharedString.parseList(value)];
}

/** Parse a decimal integer while preserving the full UniFFI integer range. */
function parseInteger(value: string | bigint, name: string, signed: boolean): bigint {
  const text = String(value).trim();
  const pattern = signed ? /^-?\d+$/ : /^\d+$/;
  if (!pattern.test(text)) {
    throw new InvalidArgumentError(`${name} must be a ${signed ? "" : "non-negative "}integer`);
  }
  return BigInt(text);
}

/** Translate the CLI storage name to the generated UniFFI enum. */
function bindingStorage(storage: StorageName): auth.Storage {
  switch (storage) {
    case "auto":
      return auth.Storage.Auto;
    case "memory":
      return auth.Storage.Memory;
    case "file":
      return auth.Storage.File;
  }
}

/** Translate the generated UniFFI enum to the CLI status value. */
function storageName(storage: auth.Storage): StorageName {
  switch (storage) {
    case auth.Storage.Auto:
      return "auto";
    case auth.Storage.Memory:
      return "memory";
    case auth.Storage.File:
      return "file";
    default:
      throw new Error(`Unknown Databricks auth storage value: ${storage}`);
  }
}

/** Build the generated options record from parsed Commander values. */
function bindingOptions(options: AuthCliOptions): databricksAuth.DatabricksAuthOptions {
  return databricksAuth.DatabricksAuthOptions.create({
    profile: options.profile,
    host: options.host,
    accountId: options.accountId,
    workspaceId: options.workspaceId,
    configFile: options.configFile,
    clientId: options.clientId,
    groupId: options.groupId,
    authType: options.authType,
    scopes: options.scopes?.length ? options.scopes : undefined,
    target: options.target,
    cacheDir: options.cacheDir,
    auth: auth.AuthOptions.create({
      callbackImageSrc: options.callbackImageSrc,
      lockTimeoutSeconds: parseInteger(options.lockTimeoutSeconds, "--lock-timeout-seconds", false),
      loginTimeoutSeconds: parseInteger(
        options.loginTimeoutSeconds,
        "--login-timeout-seconds",
        false,
      ),
      refreshBufferSeconds: parseInteger(
        options.refreshBufferSeconds,
        "--refresh-buffer-seconds",
        true,
      ),
    }),
    preferUserToMachine: options.preferUserToMachine,
  });
}

/** Open the selected binding storage and retain any owned cleanup work. */
async function openAuth(
  options: AuthCliOptions,
  dependencies: AuthCliDependencies,
): Promise<AuthContext> {
  return {
    auth: await dependencies.createPersistentAuth(
      bindingOptions(options),
      bindingStorage(options.storage),
    ),
    close: async () => {},
  };
}

/** Execute an auth action and close resources owned by the command. */
async function withAuth(
  options: AuthCliOptions,
  dependencies: AuthCliDependencies,
  action: (context: AuthContext) => Promise<void>,
): Promise<void> {
  const context = await openAuth(options, dependencies);
  try {
    await action(context);
  } finally {
    await context.close();
  }
}

/** Shape a generated token record for stable CLI JSON output. */
function tokenJson(token: auth.AccessToken): Record<string, unknown> {
  return {
    access_token: token.accessToken,
    token_type: token.tokenType,
    ...(token.expiry ? { expiry: token.expiry } : {}),
    ...(token.scopes.length ? { scopes: token.scopes } : {}),
  };
}

/** Register options shared by every auth operation. */
function addCommonOptions(program: Command): Command {
  return program
    .addOption(
      new Option("--profile <name>", "Databricks CLI profile").env("DATABRICKS_CONFIG_PROFILE"),
    )
    .addOption(new Option("--host <url>", "Databricks host").env("DATABRICKS_HOST"))
    .addOption(
      new Option("--account-id <id>", "Databricks account id").env("DATABRICKS_ACCOUNT_ID"),
    )
    .addOption(
      new Option("--workspace-id <id>", "Databricks workspace id").env("DATABRICKS_WORKSPACE_ID"),
    )
    .addOption(
      new Option("--config-file <path>", "Databricks config file").env("DATABRICKS_CONFIG_FILE"),
    )
    .addOption(new Option("--client-id <id>", "OAuth client id").env("DATABRICKS_CLIENT_ID"))
    .addOption(
      new Option("--group-id <id>", "Assumed Databricks group id").env("DATABRICKS_GROUP_ID"),
    )
    .addOption(
      new Option("--auth-type <type>", "Databricks authentication type")
        .choices(["databricks-cli", "oauth-m2m"])
        .env("DATABRICKS_AUTH_TYPE"),
    )
    .addOption(
      new Option("--scopes <scopes>", "OAuth scopes, repeatable or comma-separated").argParser(
        collectScopes,
      ),
    )
    .addOption(
      new Option("--target <target>", "OAuth target")
        .choices(["workspace", "account", "unified"])
        .env("DBX_TOOLS_U2M_TARGET"),
    )
    .addOption(
      new Option("--storage <storage>", "Credential storage")
        .choices(["auto", "memory", "file"])
        .default("auto")
        .env("DBX_TOOLS_U2M_STORAGE"),
    )
    .addOption(
      new Option("--cache-dir <path>", "Credential cache directory").env("DBX_TOOLS_U2M_CACHE_DIR"),
    )
    .addOption(
      new Option(
        "--callback-image-src <src>",
        "Callback logo URL or data URI (defaults to dbx tools branding)",
      ),
    )
    .addOption(
      new Option("--lock-timeout-seconds <seconds>", "Credential lock timeout")
        .default("30")
        .env("DBX_TOOLS_U2M_LOCK_TIMEOUT_SECONDS"),
    )
    .addOption(
      new Option("--login-timeout-seconds <seconds>", "Browser login timeout")
        .default("3600")
        .env("DBX_TOOLS_U2M_LOGIN_TIMEOUT_SECONDS"),
    )
    .addOption(
      new Option("--refresh-buffer-seconds <seconds>", "Token refresh buffer")
        .default("300")
        .env("DBX_TOOLS_U2M_REFRESH_BUFFER_SECONDS"),
    )
    .option(
      "--no-prefer-user-to-machine",
      "Use selected M2M credentials without preferring a matching user profile",
    );
}

/** Build the `dbx auth` Commander program without parsing arguments. */
export function buildProgram(
  name = "dbx auth",
  overrides: Partial<AuthCliDependencies> = {},
): Command {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const program = addCommonOptions(
    new Command()
      .name(name)
      .description("Authenticate to Databricks with user or machine OAuth")
      .showHelpAfterError(),
  );
  const options = (): AuthCliOptions => program.opts<AuthCliOptions>();

  program
    .command("login")
    .description("Authenticate and return an access token")
    .action(async () => {
      await withAuth(options(), dependencies, async ({ auth }) => {
        dependencies.writeJson(tokenJson(await auth.token(true)));
      });
    });

  program
    .command("token")
    .description("Return a valid access token")
    .option("--force-refresh", "Refresh the token before returning it")
    .option("--login-if-missing", "Run browser OAuth when no credential is stored")
    .action(async (tokenOptions: TokenCommandOptions) => {
      await withAuth(options(), dependencies, async ({ auth }) => {
        const token = tokenOptions.forceRefresh
          ? await auth.forceRefreshToken()
          : tokenOptions.loginIfMissing
            ? await auth.token()
            : await auth.token(false);
        dependencies.writeJson(tokenJson(token));
      });
    });

  program
    .command("logout")
    .description("Delete the stored credential for the selected profile")
    .action(async () => {
      await withAuth(options(), dependencies, async ({ auth }) => {
        await auth.logout();
      });
    });

  program
    .command("status")
    .description("Show the resolved profile, host, and storage backend")
    .action(async () => {
      await withAuth(options(), dependencies, async (context) => {
        const status = context.auth.status();
        dependencies.writeJson({
          profile: status.profile,
          host: status.host,
          storage: context.storage ?? storageName(status.storage),
        });
      });
    });

  return program;
}

/** Parse `argv` and run the selected auth operation. */
export async function runCli(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}

export { CommanderError };
