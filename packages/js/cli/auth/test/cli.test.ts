import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AccessToken,
  PersistentAuthLike,
  StorageAdapter,
  U2mBindings,
  U2mOptions,
} from "@dbx-tools/auth-u2m/runtime";
import type { Pool } from "pg";

import { buildProgram } from "../src/cli.ts";

const STORAGE = {
  Auto: 1,
  Memory: 2,
  File: 3,
  Keyring: 4,
} as const;

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
        storage: STORAGE.Keyring,
      };
    },
    async token(login) {
      calls.push(`token:${String(login)}`);
      return TOKEN;
    },
  };
}

function fakeBindings(
  calls: string[],
  createPersistentAuth?: (options: U2mOptions, storage?: number) => void,
  createPersistentAuthWithStorage?: (options: U2mOptions, storage: StorageAdapter) => void,
): U2mBindings {
  return {
    U2mOptions: {
      create: (options = {}) => ({
        lockTimeoutSeconds: 30n,
        loginTimeoutSeconds: 3600n,
        refreshBufferSeconds: 300n,
        ...options,
      }),
    },
    Storage: STORAGE,
    async createPersistentAuth(options, storage) {
      createPersistentAuth?.(options, storage);
      return fakeAuth(calls);
    },
    async createPersistentAuthWithStorage(options, storage) {
      createPersistentAuthWithStorage?.(options, storage);
      return fakeAuth(calls);
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
        loadBindings: async () => fakeBindings(calls),
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
      loadBindings: async () => fakeBindings(logoutCalls),
    }).parseAsync(["logout"], { from: "user" });
    assert.deepEqual(logoutCalls, ["logout"]);

    const statusCalls: string[] = [];
    const output: unknown[] = [];
    await buildProgram("dbx auth", {
      loadBindings: async () => fakeBindings(statusCalls),
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
    let capturedOptions: U2mOptions | undefined;
    let capturedStorage: number | undefined;

    await buildProgram("dbx auth", {
      loadBindings: async () =>
        fakeBindings([], (options, storage) => {
          capturedOptions = options;
          capturedStorage = storage;
        }),
      writeJson: () => {},
    }).parseAsync(
      [
        "--profile",
        "TEST",
        "--target",
        "workspace",
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
    assert.equal(capturedOptions?.callbackImageSrc, "data:image/svg+xml,logo");
    assert.deepEqual(capturedOptions?.scopes, ["scope-a", "scope-b", "scope-c"]);
    assert.equal(capturedOptions?.lockTimeoutSeconds, 12n);
    assert.equal(capturedOptions?.loginTimeoutSeconds, 34n);
    assert.equal(capturedOptions?.refreshBufferSeconds, -5n);
    assert.equal(capturedStorage, STORAGE.Memory);
  });

  it("uses the Node Postgres adapter and closes the owned pool", async () => {
    const calls: string[] = [];
    const output: unknown[] = [];
    const pool = {
      async end() {
        calls.push("pool:end");
      },
    } as unknown as Pool;

    await buildProgram("dbx auth", {
      createPostgresPool: (connectionString) => {
        calls.push(`pool:${connectionString}`);
        return pool;
      },
      createPostgresStorage: () => {
        calls.push("storage:create");
        return {} as StorageAdapter;
      },
      loadBindings: async () =>
        fakeBindings(calls, undefined, () => {
          calls.push("auth:create-postgres");
        }),
      writeJson: (value) => output.push(value),
    }).parseAsync(
      ["--postgres-url", "postgresql://localhost/auth", "--storage", "postgres", "status"],
      { from: "user" },
    );

    assert.deepEqual(calls, [
      "pool:postgresql://localhost/auth",
      "storage:create",
      "auth:create-postgres",
      "status",
      "pool:end",
    ]);
    assert.deepEqual(output, [
      {
        profile: "TEST",
        host: "https://example.cloud.databricks.com",
        storage: "postgres",
      },
    ]);
  });
});
