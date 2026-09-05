import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type DatabricksAuthOptions, type PersistentAuthLike } from "@dbx-tools/databricks-auth";
import { Storage, type AccessToken } from "@dbx-tools/auth";

import { buildProgram } from "../src/cli.ts";

const TOKEN: AccessToken = {
  accessToken: "access",
  tokenType: "Bearer",
  expiry: "2026-09-04T20:00:00Z",
  scopes: ["scope-a"],
};

function fakeAuth(calls: string[]): PersistentAuthLike {
  return {
    async challenge() {
      calls.push("challenge");
    },
    async refreshRejectedToken() {
      return TOKEN;
    },
    async forceRefreshToken() {
      calls.push("force-refresh");
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
        storage: Storage.Keyring,
      };
    },
    async token(login) {
      calls.push(`token:${String(login)}`);
      return TOKEN;
    },
  };
}

describe("auth CLI", () => {
  it("routes login and token operations through PersistentAuth", async () => {
    const cases = [
      { args: ["login"], expected: "token:true" },
      { args: ["token"], expected: "token:false" },
      { args: ["token", "--login-if-missing"], expected: "token:undefined" },
      { args: ["token", "--force-refresh"], expected: "force-refresh" },
    ];

    for (const testCase of cases) {
      const calls: string[] = [];
      const output: unknown[] = [];
      await buildProgram("dbx auth", {
        createPersistentAuth: async () => fakeAuth(calls),
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

  it("routes logout and status through PersistentAuth", async () => {
    const logoutCalls: string[] = [];
    await buildProgram("dbx auth", {
      createPersistentAuth: async () => fakeAuth(logoutCalls),
    }).parseAsync(["logout"], { from: "user" });
    assert.deepEqual(logoutCalls, ["logout"]);

    const statusCalls: string[] = [];
    const output: unknown[] = [];
    await buildProgram("dbx auth", {
      createPersistentAuth: async () => fakeAuth(statusCalls),
      writeJson: (value) => output.push(value),
    }).parseAsync(["status"], { from: "user" });
    assert.deepEqual(statusCalls, ["status"]);
    assert.deepEqual(output, [
      {
        profile: "TEST",
        host: "https://example.cloud.databricks.com",
        storage: "keyring",
      },
    ]);
  });

  it("translates common options to the generated binding record", async () => {
    let capturedOptions: DatabricksAuthOptions | undefined;
    let capturedStorage: Storage | undefined;

    await buildProgram("dbx auth", {
      createPersistentAuth: async (options, storage) => {
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
        "--callback-image-src",
        "data:image/svg+xml,logo",
        "--scopes",
        "scope-a,scope-b",
        "--scopes",
        "scope-c",
        "--lock-timeout-seconds",
        "12",
        "--login-timeout-seconds",
        "34",
        "--refresh-buffer-seconds",
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
    assert.equal(capturedOptions?.callbackImageSrc, "data:image/svg+xml,logo");
    assert.deepEqual(capturedOptions?.scopes, ["scope-a", "scope-b", "scope-c"]);
    assert.equal(capturedOptions?.lockTimeoutSeconds, 12n);
    assert.equal(capturedOptions?.loginTimeoutSeconds, 34n);
    assert.equal(capturedOptions?.refreshBufferSeconds, -5n);
    assert.equal(capturedStorage, Storage.Memory);
  });
});
