/**
 * `dbx auth` Commander program for Databricks OAuth.
 *
 * The command delegates profile resolution and token lifecycle to
 * `@dbx-tools/auth`.
 *
 * @module
 */

import * as databricks from "@dbx-tools/auth";
import {
  AuthType,
  type AuthType as AuthTypeValue,
  TargetKind,
  type TargetKind as TargetKindValue,
} from "@dbx-tools/shared-auth";
import type { DatabricksAuthClientInfo } from "@dbx-tools/shared-auth/client";
import { stringUtils } from "@dbx-tools/shared-core";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

interface AuthCliOptions {
  profile?: string;
  host?: string;
  accountId?: string;
  workspaceId?: string;
  configFile?: string;
  clientId?: string;
  groupId?: string;
  authType?: AuthTypeValue;
  scopes?: string[];
  target?: TargetKindValue;
  lockTimeoutMs: string;
  loginTimeoutMs: string;
  refreshBufferMs: string;
  preferUserToMachine: boolean;
}

interface TokenCommandOptions {
  forceRefresh?: boolean;
  login?: boolean;
}

interface AuthContext {
  auth: databricks.AuthClient;
  close(): Promise<void>;
}

interface AuthCliDependencies {
  createAuthClient: typeof databricks.client.createAuthClient;
  writeJson(value: unknown): void;
  writeText(value: string): void;
}

const DEFAULT_AUTH_OPTIONS = databricks.AUTH_DEFAULTS;

const DEFAULT_DEPENDENCIES: AuthCliDependencies = {
  createAuthClient: databricks.client.createAuthClient,
  writeJson: (value) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  },
  writeText: (value) => {
    process.stdout.write(`${value}\n`);
  },
};

/** Collect comma-separated and repeated scope values into one ordered list. */
function collectScopes(value: string, previous: string[] = []): string[] {
  return [...previous, ...stringUtils.parseList(value)];
}

/** Parse a decimal integer for lifecycle timeout configuration. */
function parseInteger(value: string | number, name: string, signed: boolean): number {
  const text = String(value).trim();
  const pattern = signed ? /^-?\d+$/ : /^\d+$/;
  if (!pattern.test(text)) {
    throw new InvalidArgumentError(`${name} must be a ${signed ? "" : "non-negative "}integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`${name} is outside the safe integer range`);
  }
  return parsed;
}

/** Build authentication options from parsed Commander values. */
function bindingOptions(options: AuthCliOptions): databricks.DatabricksAuthOptions {
  return {
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
    auth: {
      lockTimeoutMs: parseInteger(options.lockTimeoutMs, "--lock-timeout-ms", false),
      loginTimeoutMs: parseInteger(options.loginTimeoutMs, "--login-timeout-ms", false),
      refreshBufferMs: parseInteger(options.refreshBufferMs, "--refresh-buffer-ms", true),
    },
    preferUserToMachine: options.preferUserToMachine,
  };
}

/** Open the selected authentication client. */
async function openAuth(
  options: AuthCliOptions,
  dependencies: AuthCliDependencies,
): Promise<AuthContext> {
  return {
    auth: await dependencies.createAuthClient(bindingOptions(options)),
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
function tokenJson(token: databricks.AccessToken): Record<string, unknown> {
  return {
    access_token: token.accessToken,
    token_type: token.tokenType,
    ...(token.expiry ? { expiry: token.expiry } : {}),
    ...(token.scopes.length ? { scopes: token.scopes } : {}),
  };
}

/** Select the serializable identity fields from an authentication client. */
function clientInfo(auth: databricks.AuthClient): DatabricksAuthClientInfo {
  return {
    ...(auth.profile ? { profile: auth.profile } : {}),
    host: auth.host,
    ...(auth.accountId ? { accountId: auth.accountId } : {}),
    ...(auth.workspaceId ? { workspaceId: auth.workspaceId } : {}),
    target: auth.target,
    authType: auth.authType,
    principal: auth.principal,
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
        .choices(Object.values(AuthType))
        .env("DATABRICKS_AUTH_TYPE"),
    )
    .addOption(
      new Option("--scopes <scopes>", "OAuth scopes, repeatable or comma-separated").argParser(
        collectScopes,
      ),
    )
    .addOption(
      new Option("--target <target>", "OAuth target")
        .choices(Object.values(TargetKind))
        .env("DBX_TOOLS_U2M_TARGET"),
    )
    .addOption(
      new Option("--lock-timeout-ms <ms>", "Credential lock timeout (0 waits indefinitely)")
        .default(DEFAULT_AUTH_OPTIONS.lockTimeoutMs.toString())
        .env("DBX_TOOLS_U2M_LOCK_TIMEOUT_MS"),
    )
    .addOption(
      new Option("--login-timeout-ms <ms>", "Browser login timeout")
        .default(DEFAULT_AUTH_OPTIONS.loginTimeoutMs.toString())
        .env("DBX_TOOLS_U2M_LOGIN_TIMEOUT_MS"),
    )
    .addOption(
      new Option("--refresh-buffer-ms <ms>", "Token refresh buffer")
        .default(DEFAULT_AUTH_OPTIONS.refreshBufferMs.toString())
        .env("DBX_TOOLS_U2M_REFRESH_BUFFER_MS"),
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
    .description("Force browser login and return an access token")
    .action(async () => {
      await withAuth(options(), dependencies, async ({ auth }) => {
        dependencies.writeJson(tokenJson(await auth.token({ login: true })));
      });
    });

  program
    .command("token")
    .description("Return a valid access token, logging in when needed")
    .option("--force-refresh", "Refresh the token before returning it")
    .option("--no-login", "Fail instead of logging in for a missing or invalid credential")
    .action(async (tokenOptions: TokenCommandOptions) => {
      await withAuth(options(), dependencies, async ({ auth }) => {
        const login = tokenOptions.login === false ? false : undefined;
        const token = await auth.token({
          ...(login === undefined ? {} : { login }),
          refresh: tokenOptions.forceRefresh,
        });
        dependencies.writeJson(tokenJson(token));
      });
    });

  program
    .command("profile")
    .description("Print the configured or automatically detected profile")
    .action(async () => {
      await withAuth(options(), dependencies, async ({ auth }) => {
        dependencies.writeText(auth.profile ?? "ambient");
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
    .description("Show the resolved authentication client configuration")
    .action(async () => {
      await withAuth(options(), dependencies, async ({ auth }) => {
        dependencies.writeJson(clientInfo(auth));
      });
    });

  return program;
}

/** Parse `argv` and run the selected auth operation. */
export async function runCli(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}

export { CommanderError };
