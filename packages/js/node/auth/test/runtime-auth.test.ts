import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { RUNTIME_AUTH_TYPE } from "@dbx-tools/shared-auth/client";
import { createAuthClient } from "../src/client.ts";
import {
  _databricksRuntimeAuthClient,
  createDatabricksRuntimeAuthClient,
  type DatabricksRuntimeAuthClient,
} from "../src/runtime-auth.ts";

function accessToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    exp: Math.floor(Date.now() / 1000) + 3600,
    scope: "all-apis sql",
  })}.signature`;
}

describe("Databricks runtime authentication", () => {
  it("is unavailable in ordinary Node execution", async () => {
    assert.equal(await _databricksRuntimeAuthClient(), undefined);
  });

  it("uses the standard token lifecycle around Python runtime credentials", async () => {
    const token = accessToken();
    let authentications = 0;
    const runtime: DatabricksRuntimeAuthClient = {
      host: "https://workspace.example.com/",
      workspaceId: "workspace-id",
      principal: "runtime-user",
      token: async () => undefined,
      authenticate: async () => {
        authentications += 1;
        return {
          Authorization: `Bearer ${token}`,
          "X-Runtime-Header": "runtime-value",
        };
      },
    };
    const runtimeKey = Symbol.for("@dbx-tools/node-runtime/runtime");
    const previous = Reflect.get(globalThis, runtimeKey);
    Reflect.set(globalThis, runtimeKey, {
      databricksRuntimeAuthClient: async () => runtime,
    });
    try {
      const auth = await createAuthClient();
      const [first, second] = await Promise.all([auth.token(), auth.token()]);
      assert.equal(first.accessToken, token);
      assert.deepEqual(first.scopes, ["all-apis", "sql"]);
      assert.equal(second.accessToken, token);
      assert.equal(authentications, 1);
      assert.equal(auth.host, "https://workspace.example.com");
      assert.equal(auth.workspaceId, "workspace-id");
      assert.equal(auth.principal, "runtime-user");
      assert.equal(auth.authType, RUNTIME_AUTH_TYPE);
      assert.deepEqual(await auth.headers(), {
        authorization: `Bearer ${token}`,
        "x-runtime-header": "runtime-value",
        "x-databricks-workspace-id": "workspace-id",
      });
      assert.equal(authentications, 1);

      await auth.token({ refresh: true });
      assert.equal(authentications, 2);

      const explicit = await createAuthClient({
        host: "https://explicit.example.com",
        authType: "pat",
        accessToken: "explicit-token",
        configFile: "missing-runtime-auth-config",
      });
      assert.equal((await explicit.token()).accessToken, "explicit-token");
      assert.equal(authentications, 2);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, runtimeKey);
      else Reflect.set(globalThis, runtimeKey, previous);
    }
  });

  it("uses a directly configured SDK token when authenticate omits authorization", async () => {
    const runtime: DatabricksRuntimeAuthClient = {
      host: "https://workspace.example.com",
      token: async () => "configured-token",
      authenticate: async () => ({}),
    };
    const auth = createDatabricksRuntimeAuthClient(runtime, {});

    assert.ok((await auth.token()).expiry);
    assert.deepEqual(await auth.headers(), {
      authorization: "Bearer configured-token",
    });
  });
});
