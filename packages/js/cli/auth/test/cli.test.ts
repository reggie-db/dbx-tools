import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type AccessToken, type AuthClient, type DatabricksAuthOptions } from "@dbx-tools/auth";
import { AuthType, TargetKind } from "@dbx-tools/shared-auth";

import { buildProgram } from "../src/cli.ts";

const TOKEN: AccessToken = {
  accessToken: "access",
  tokenType: "Bearer",
  expiry: "2026-09-04T20:00:00Z",
  scopes: ["scope-a"],
};

function fakeAuth(calls: string[]): AuthClient {
  return {
    profile: "TEST",
    host: "https://example.cloud.databricks.com",
    target: TargetKind.Workspace,
    authType: AuthType.DatabricksCli,
    principal: "TEST",
    async logout() {
      calls.push("logout");
    },
    async token(options) {
      calls.push(`token:${JSON.stringify(options ?? {})}`);
      return TOKEN;
    },
    async headers() {
      return { authorization: "Bearer access" };
    },
  };
}

describe("auth CLI", () => {
  it("routes login and token operations through AuthClient", async () => {
    const cases = [
      { args: ["login"], expected: 'token:{"login":true}' },
      { args: ["token"], expected: "token:{}" },
      { args: ["token", "--no-login"], expected: 'token:{"login":false}' },
      { args: ["token", "--force-refresh"], expected: 'token:{"refresh":true}' },
      {
        args: ["token", "--force-refresh", "--no-login"],
        expected: 'token:{"login":false,"refresh":true}',
      },
    ];

    for (const testCase of cases) {
      const calls: string[] = [];
      const output: unknown[] = [];
      await buildProgram("dbx auth", {
        createAuthClient: async () => fakeAuth(calls),
        writeJson: (value) => output.push(value),
      }).parseAsync(testCase.args, { from: "user" });

      assert.deepEqual(calls, [testCase.expected]);
      assert.deepEqual(output, [
        {
          access_token: "access",
          token_type: "Bearer",
          expiry: "2026-09-04T20:00:00Z",
          scopes: ["scope-a"],
        },
      ]);
    }
  });

  it("routes logout, profile, and status through AuthClient", async () => {
    const logoutCalls: string[] = [];
    await buildProgram("dbx auth", {
      createAuthClient: async () => fakeAuth(logoutCalls),
    }).parseAsync(["logout"], { from: "user" });
    assert.deepEqual(logoutCalls, ["logout"]);

    const statusCalls: string[] = [];
    const output: unknown[] = [];
    await buildProgram("dbx auth", {
      createAuthClient: async () => fakeAuth(statusCalls),
      writeJson: (value) => output.push(value),
    }).parseAsync(["status"], { from: "user" });
    assert.deepEqual(statusCalls, []);
    assert.deepEqual(output, [
      {
        profile: "TEST",
        host: "https://example.cloud.databricks.com",
        target: TargetKind.Workspace,
        authType: AuthType.DatabricksCli,
        principal: "TEST",
      },
    ]);

    const profileCalls: string[] = [];
    const profileOutput: string[] = [];
    await buildProgram("dbx auth", {
      createAuthClient: async () => fakeAuth(profileCalls),
      writeText: (value) => profileOutput.push(value),
    }).parseAsync(["profile"], { from: "user" });
    assert.deepEqual(profileCalls, []);
    assert.deepEqual(profileOutput, ["TEST"]);
  });

  it("describes automatic login and its opt-out", () => {
    const program = buildProgram("dbx auth");
    const token = program.commands.find((command) => command.name() === "token");
    const profile = program.commands.find((command) => command.name() === "profile");

    assert.match(token?.description() ?? "", /logging in when needed/);
    assert.match(token?.helpInformation() ?? "", /--no-login/);
    assert.doesNotMatch(token?.helpInformation() ?? "", /--login-if-missing/);
    assert.match(profile?.description() ?? "", /configured or automatically detected profile/);
  });

  it("translates common options to the generated binding record", async () => {
    let capturedOptions: DatabricksAuthOptions | undefined;

    await buildProgram("dbx auth", {
      createAuthClient: async (options) => {
        capturedOptions = options;
        return fakeAuth([]);
      },
      writeJson: () => {},
    }).parseAsync(
      [
        "--profile",
        "TEST",
        "--target",
        "workspace",
        "--auth-type",
        AuthType.OAuthM2M,
        "--group-id",
        "group",
        "--no-prefer-user-to-machine",
        "--scopes",
        "scope-a,scope-b",
        "--scopes",
        "scope-c",
        "--lock-timeout-ms",
        "12",
        "--login-timeout-ms",
        "34",
        "--refresh-buffer-ms",
        "-5",
        "login",
      ],
      { from: "user" },
    );

    assert.equal(capturedOptions?.profile, "TEST");
    assert.equal(capturedOptions?.target, "workspace");
    assert.equal(capturedOptions?.authType, AuthType.OAuthM2M);
    assert.equal(capturedOptions?.groupId, "group");
    assert.equal(capturedOptions?.preferUserToMachine, false);
    assert.deepEqual(capturedOptions?.scopes, ["scope-a", "scope-b", "scope-c"]);
    assert.equal(capturedOptions?.auth?.lockTimeoutMs, 12);
    assert.equal(capturedOptions?.auth?.loginTimeoutMs, 34);
    assert.equal(capturedOptions?.auth?.refreshBufferMs, -5);
  });
});
