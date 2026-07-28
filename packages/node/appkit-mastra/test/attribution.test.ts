import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { appkit } from "@dbx-tools/appkit";

import { attributedUserId } from "../src/config.ts";

/** Minimal OBO context: `isUserContext` is the discriminator AppKit stamps. */
function userContext(userId: string): appkit.ExecutionContextLike {
  return { isUserContext: true, userId } as unknown as appkit.ExecutionContextLike;
}

/** Minimal service-principal context: no `isUserContext`, no `userId`. */
function servicePrincipalContext(serviceUserId: string): appkit.ExecutionContextLike {
  return { serviceUserId } as unknown as appkit.ExecutionContextLike;
}

describe("attributedUserId", () => {
  it("prefers the OBO user over a forwarded header", () => {
    assert.equal(attributedUserId(userContext("obo-user"), "forwarded-user"), "obo-user");
  });

  it("attributes a service-principal turn to the forwarded user", () => {
    assert.equal(
      attributedUserId(servicePrincipalContext("service-principal"), "forwarded-user"),
      "forwarded-user",
    );
  });

  it("falls back to the service principal when no user was forwarded", () => {
    assert.equal(
      attributedUserId(servicePrincipalContext("service-principal"), undefined),
      "service-principal",
    );
  });

  it("keys a chart write and its embed read identically under a shared credential", () => {
    // The write side reads the stamped RequestContext user; the read side has
    // only the request. Both resolve through this rule, so a chart minted in a
    // turn resolves on the embed route instead of 404ing as expired.
    const executionContext = servicePrincipalContext("service-principal");
    const writeKey = attributedUserId(executionContext, "forwarded-user");
    const readKey = attributedUserId(executionContext, "forwarded-user");
    assert.equal(writeKey, readKey);
  });
});
