import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type AccessToken,
  type AuthClient,
  AuthKind,
  type DatabricksAuthOptions,
  Storage,
  TargetKind,
} from "@dbx-tools/auth";

import { buildProgram } from "../src/cli.ts";

const TOKEN: AccessToken = {
  accessToken: "access",
  tokenType: "Bearer",
  expiry: "2026-09-04T20:00:00Z",
  scopes: ["scope-a"],
};

function fakeAuth(calls: string[]): AuthClient {
  return {
    async challenge() {
      calls.push("challenge");
    },
    async refreshRejectedToken() {
      return TOKEN;
    },
    async forceRefreshToken(login) {
      calls.push(`force-refresh:${String(login)}`);
      return TOKEN;
    },
    async logout() {
      calls.push("logout");
    },
    status() {
      calls.push("status");
      return {
        profile: "TEST",
        host: "https://example.cloud.databricks.com",
        storage: Storage.File,
      };
    },
    async token(login) {
      calls.push(`token:${String(login)}`);
      return TOKEN;
    },
    async authenticate() {
      return { authorization: "Bearer access" };
    },
    async authorizationHeaderForUrl() {
      return "Bearer access";
    },
    async requestHeadersForUrl() {
      return { authorization: "Bearer access" };
    },
    principal() {
      return "TEST";
    },
    workspaceId() {
      return undefined;
    },
    authKind() {
      return AuthKind.UserToMachine;
    },
    profile() {
      calls.push("profile");
      return {
        name: "TEST",
        host: "https://example.cloud.databricks.com",
        target: TargetKind.Workspace,
        authKind: AuthKind.UserToMachine,
      };
    },
    listProfiles() {
      return [];
    },
  };
}

describe("auth CLI", () => {
  it("routes login and token operations through AuthClient", async () => {
    const cases = [
      { args: ["login"], expected: "token:true" },
      { args: ["token"], expected: "token:undefined" },
      { args: ["token", "--no-login"], expected: "token:false" },
      { args: ["token", "--force-refresh"], expected: "force-refresh:undefined" },
      {
        args: ["token", "--force-refresh", "--no-login"],
        expected: "force-refresh:false",
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
    assert.deepEqual(statusCalls, ["status"]);
    assert.deepEqual(output, [
      {
        profile: "TEST",
        host: "https://example.cloud.databricks.com",
        storage: "file",
      },
    ]);

    const profileCalls: string[] = [];
    const profileOutput: string[] = [];
    await buildProgram("dbx auth", {
      createAuthClient: async () => fakeAuth(profileCalls),
      writeText: (value) => profileOutput.push(value),
    }).parseAsync(["profile"], { from: "user" });
    assert.deepEqual(profileCalls, ["profile"]);
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
    let capturedStorage: Storage | undefined;

    await buildProgram("dbx auth", {
      createAuthClient: async (options, storage) => {
        capturedOptions = options;
        capturedStorage = storage;
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
        "oauth-m2m",
        "--group-id",
        "group",
        "--no-prefer-user-to-machine",
        "--storage",
        "memory",
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
    assert.equal(capturedOptions?.authType, "oauth-m2m");
    assert.equal(capturedOptions?.groupId, "group");
    assert.equal(capturedOptions?.preferUserToMachine, false);
    assert.deepEqual(capturedOptions?.scopes, ["scope-a", "scope-b", "scope-c"]);
    assert.equal(capturedOptions?.auth?.lockTimeoutMs, 12);
    assert.equal(capturedOptions?.auth?.loginTimeoutMs, 34);
    assert.equal(capturedOptions?.auth?.refreshBufferMs, -5);
    assert.equal(capturedStorage, Storage.Memory);
  });
});
