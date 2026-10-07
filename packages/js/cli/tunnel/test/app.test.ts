import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";

import { startGateApp } from "../src/app.ts";

describe("server-less AppKit gate", () => {
  it("uses the same authGate plugin without a server plugin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-cli-auth-"));
    const gate = await startGateApp(
      {
        allow: ["example.com"],
        publicDomain: "localhost",
        storage: "sqlite",
        sqlitePath: join(directory, "auth.sqlite"),
        sendCode: async () => undefined,
      },
      {
        apiClient: {
          async request() {
            return { "x-databricks-org-id": "test-workspace" };
          },
        },
        currentUser: {
          async me() {
            return { id: "test-user" };
          },
        },
      } as unknown as WorkspaceClient,
    );

    const status = await gate.status(new Headers());
    assert.deepEqual(status, {
      authenticated: false,
      enabled: true,
      passkeysEnabled: true,
    });

    await gate.close();
    await rm(directory, { recursive: true, force: true });
  });
});
