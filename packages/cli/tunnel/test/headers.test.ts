import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { token } from "@dbx-tools/shared-core";
import { DEFAULT_FORWARD_HEADERS, PROTECTED_HEADERS, toHeaderPolicy } from "../src/headers.ts";

describe("inbound header policy", () => {
  it("forwards every non-x- header untouched", () => {
    const policy = toHeaderPolicy();
    for (const name of ["content-type", "accept", "authorization", "cookie", "host"]) {
      assert.equal(policy.forwards(name), true);
    }
  });

  it("strips an unknown x- header (fails closed)", () => {
    const policy = toHeaderPolicy();
    assert.equal(policy.forwards("x-something-nobody-planned-for"), false);
  });

  it("forwards the repo's own x- namespaces by default", () => {
    const policy = toHeaderPolicy();
    assert.equal(policy.forwards("x-mastra-thread-id"), true);
    assert.equal(policy.forwards("x-mastra-model"), true);
    assert.equal(policy.forwards("x-mlflow-trace-id"), true);
    assert.equal(policy.forwards("x-requested-with"), true);
  });

  it("forwards configured literals, globs, and /regex/es on top of the defaults", () => {
    const policy = toHeaderPolicy(["x-myapp-*", "/^x-trace-/", "x-tenant"]);
    assert.equal(policy.forwards("x-myapp-tenant"), true);
    assert.equal(policy.forwards("x-trace-parent"), true);
    assert.equal(policy.forwards("x-tenant"), true);
    // The built-ins survive configuration.
    assert.equal(policy.forwards("x-mastra-model"), true);
    assert.equal(policy.forwards("x-other"), false);
  });

  it("never forwards a protected header, even for a catch-all pattern", () => {
    const policy = toHeaderPolicy(["*", "x-*", "/.*/"]);
    for (const name of PROTECTED_HEADERS) {
      assert.equal(policy.forwards(name), false, name);
      assert.equal(policy.forwards(name.toUpperCase()), false, name);
    }
    // The catch-all still works for anything unprotected.
    assert.equal(policy.forwards("x-whatever"), true);
  });

  it("protects the access token, identity, and transport headers by name", () => {
    // Spelled out so a future edit to the list is a deliberate, reviewed change.
    assert.deepEqual(
      [...PROTECTED_HEADERS],
      [
        token.ACCESS_TOKEN_HEADER,
        token.USER_ID_HEADER,
        token.USER_EMAIL_HEADER,
        "x-forwarded-preferred-username",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-forwarded-port",
        "x-forwarded-for",
        "x-real-ip",
        "x-request-id",
      ],
    );
  });

  it("deletes disallowed headers from a bag and reports what it removed", () => {
    const headers: Record<string, unknown> = {
      "content-type": "application/json",
      "X-Forwarded-Access-Token": "stolen",
      "x-forwarded-user": "victim@example.com",
      "x-forwarded-for": "1.2.3.4",
      "x-mastra-thread-id": "t1",
      "x-evil": "1",
    };
    const removed = toHeaderPolicy().apply(headers);
    assert.deepEqual(Object.keys(headers), ["content-type", "x-mastra-thread-id"]);
    assert.deepEqual(removed.sort(), [
      "x-evil",
      "x-forwarded-access-token",
      "x-forwarded-for",
      "x-forwarded-user",
    ]);
  });

  it("exposes the union of default and configured patterns", () => {
    const policy = toHeaderPolicy(["x-myapp-*"]);
    assert.deepEqual(policy.patterns, [...DEFAULT_FORWARD_HEADERS, "x-myapp-*"]);
  });
});
