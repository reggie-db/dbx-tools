import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { projectUtils } from "@dbx-tools/core";

import { startGateApp } from "../src/tunnel/app.ts";

describe("server-less AppKit gate", () => {
  it("uses the same authGate plugin without a server plugin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-cli-auth-"));
    const gate = await startGateApp(
      {
        allow: ["example.com"],
        publicDomain: "alpha.tunnels.example.com",
        publicDomains: ["beta.tunnels.example.com"],
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
      passkeyNamePrefix: projectUtils.name(),
    });
    assert.equal(
      gate.isProtectedHost(new Headers({ host: "alpha.tunnels.example.com:443" })),
      true,
    );
    assert.equal(gate.isProtectedHost(new Headers({ host: "beta.tunnels.example.com" })), true);
    assert.equal(gate.isProtectedHost(new Headers({ host: "tunnels.example.com" })), false);
    assert.equal(gate.isProtectedHost(new Headers({ host: "gamma.tunnels.example.com" })), false);
    for (const hostname of ["alpha.tunnels.example.com", "beta.tunnels.example.com"]) {
      const origin = `https://${hostname}`;
      const response = await gate.handler(
        new Request(`${origin}/api/email/auth/passkey/generate-authenticate-options`, {
          headers: { origin },
        }),
      );
      assert.equal(response.status, 200);
      const options = (await response.json()) as { rpId?: string };
      assert.equal(options.rpId, hostname);
    }

    await gate.close();
    await rm(directory, { recursive: true, force: true });
  });
});
