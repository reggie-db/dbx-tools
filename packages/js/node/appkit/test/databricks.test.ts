import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthType } from "@dbx-tools/shared-auth";

import {
  createWorkspaceClient,
  refreshWorkspaceClientAuthentication,
  toContext,
} from "../src/databricks.ts";

describe("Databricks workspace client authentication", () => {
  it("delegates SDK authentication to the selected dbx-tools auth client", async () => {
    const client = await createWorkspaceClient({
      profile: "SELECTED",
      host: "https://example.cloud.databricks.com",
      workspaceId: "1234567890123456",
      authType: AuthType.PersonalAccessToken,
      accessToken: "profile-token",
    });
    const headers = new Headers();

    await client.config.authenticate(headers);

    assert.equal(headers.get("authorization"), "Bearer profile-token");
    assert.equal(headers.get("x-databricks-workspace-id"), "1234567890123456");
    assert.equal(await refreshWorkspaceClientAuthentication(client), true);
    assert.equal(client.toLegacyWorkspaceClient().config, client.config);
  });
});

describe("Databricks SDK cancellation context", () => {
  it("returns an existing SDK context unchanged", () => {
    const context = toContext(new AbortController().signal);
    context.setItems({ opName: "existing" });
    assert.equal(toContext(context), context);
  });

  it("adapts AbortSignal cancellation and preserves its reason", () => {
    const controller = new AbortController();
    const context = toContext(controller.signal);
    let reason: unknown;
    context.cancellationToken?.onCancellationRequested((value) => {
      reason = value;
    });

    controller.abort("cancelled");

    assert.equal(context.cancellationToken?.isCancellationRequested, true);
    assert.equal(reason, "cancelled");
  });

  it("propagates a parent signal into an owned controller only", () => {
    const parent = new AbortController();
    const child = new AbortController();
    const context = toContext(child, parent.signal);

    parent.abort("parent");
    assert.equal(context.cancellationToken?.isCancellationRequested, true);

    const unrelated = new AbortController();
    const unrelatedContext = toContext(unrelated, parent.signal);
    unrelated.abort("child");
    assert.equal(parent.signal.reason, "parent");
    assert.equal(unrelatedContext.cancellationToken?.isCancellationRequested, true);
  });

  it("preserves context metadata while replacing its cancellation token", () => {
    let cancelParent!: (reason?: unknown) => void;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested(callback: (reason?: unknown) => void) {
        cancelParent = callback;
      },
    };
    const parent = toContext(new AbortController().signal);
    parent.setItems({
      opName: "catalogue",
      rootClassName: "ModelClient",
      rootFnName: "list",
      cancellationToken: token,
    });
    const child = new AbortController();
    const context = toContext(child, parent);

    assert.notEqual(context, parent);
    assert.equal(context.opName, "catalogue");
    assert.equal(context.rootClassName, "ModelClient");
    assert.equal(context.rootFnName, "list");

    cancelParent("upstream");
    assert.equal(context.cancellationToken?.isCancellationRequested, true);
  });
});
