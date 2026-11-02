import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { waitForWorkspaceAuth, type WorkspaceClient } from "../src/workspace-client.ts";

function fakeClient(me: () => Promise<{ userName: string }>): WorkspaceClient {
  return { currentUser: { me } } as unknown as WorkspaceClient;
}

describe("waitForWorkspaceAuth", () => {
  it("retries the current-user lookup until it succeeds", async () => {
    let calls = 0;
    const client = fakeClient(async () => {
      calls += 1;
      if (calls < 3) throw new Error("RBAC: access denied");
      return { userName: "user@example.com" };
    });

    const me = await waitForWorkspaceAuth(client, { delaysMs: [1] });

    assert.equal(me.userName, "user@example.com");
    assert.equal(calls, 3);
  });

  it("stops waiting when the signal aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = fakeClient(async () => {
      calls += 1;
      controller.abort(new Error("stopped"));
      throw new Error("RBAC: access denied");
    });

    await assert.rejects(
      () => waitForWorkspaceAuth(client, { delaysMs: [60_000], signal: controller.signal }),
      /stopped/,
    );
    assert.equal(calls, 1);
  });
});
