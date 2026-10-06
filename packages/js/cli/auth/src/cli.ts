/**
 * `dbx auth` Commander program for Databricks OAuth.
 *
 * The command delegates profile resolution and token lifecycle to
 * `@dbx-tools/auth`.
 *
 * @module
 */

import * as databricks from "@dbx-tools/auth";
import { addArgs, parseArgs } from "@dbx-tools/cli-args/args";
import type { DatabricksAuthClientInfo } from "@dbx-tools/shared-auth/client";
import { Command, CommanderError } from "commander";

import {
  AuthCliOptionsSchema,
  databricksAuthOptions,
  TokenCommandOptionsSchema,
  type AuthCliOptions,
} from "./options.ts";

interface AuthContext {
  auth: databricks.AuthClient;
  close(): Promise<void>;
}

interface AuthCliDependencies {
  createAuthClient: typeof databricks.client.createAuthClient;
  writeJson(value: unknown): void;
  writeText(value: string): void;
}

const DEFAULT_DEPENDENCIES: AuthCliDependencies = {
  createAuthClient: databricks.client.createAuthClient,
  writeJson: (value) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  },
  writeText: (value) => {
    process.stdout.write(`${value}\n`);
  },
};

/** Open the selected authentication client. */
async function openAuth(
  options: AuthCliOptions,
  dependencies: AuthCliDependencies,
): Promise<AuthContext> {
  return {
    auth: await dependencies.createAuthClient(databricksAuthOptions(options)),
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

/** Build the `dbx auth` Commander program without parsing arguments. */
export function buildProgram(
  name = "dbx auth",
  overrides: Partial<AuthCliDependencies> = {},
): Command {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const program = addArgs(
    new Command()
      .name(name)
      .description("Authenticate to Databricks with user or machine OAuth")
      .showHelpAfterError(),
    AuthCliOptionsSchema,
  );
  const options = (): AuthCliOptions => parseArgs(program, AuthCliOptionsSchema);

  program
    .command("login")
    .description("Force browser login and return an access token")
    .action(async () => {
      await withAuth(options(), dependencies, async ({ auth }) => {
        dependencies.writeJson(tokenJson(await auth.token({ login: true })));
      });
    });

  const tokenCommand = addArgs(
    program.command("token").description("Return a valid access token, logging in when needed"),
    TokenCommandOptionsSchema,
  );
  tokenCommand.action(async () => {
    const tokenOptions = parseArgs(tokenCommand, TokenCommandOptionsSchema);
    await withAuth(options(), dependencies, async ({ auth }) => {
      const token = await auth.token({
        ...(tokenOptions.login ? {} : { login: false }),
        ...(tokenOptions.forceRefresh ? { refresh: true } : {}),
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
