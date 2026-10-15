import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AUTH_BASE_PATH, isAuthPath, passkeyDisplayName } from "../src/auth.ts";

describe("isAuthPath", () => {
  it("matches the auth route boundary only", () => {
    assert.equal(isAuthPath(AUTH_BASE_PATH), true);
    assert.equal(isAuthPath(`${AUTH_BASE_PATH}/status`), true);
    assert.equal(isAuthPath(`${AUTH_BASE_PATH}/status?fresh=true`), true);
    assert.equal(isAuthPath(`${AUTH_BASE_PATH}z/private`), false);
    assert.equal(isAuthPath(`${AUTH_BASE_PATH}-private`), false);
  });
});

describe("passkeyDisplayName", () => {
  it("combines a configurable prefix with the humanized subdomain", () => {
    assert.equal(passkeyDisplayName("DBX Tools", "demo.apps.example.com"), "DBX Tools Demo");
    assert.equal(passkeyDisplayName("Acme", "sales-demo.example.com"), "Acme Sales Demo");
    assert.equal(passkeyDisplayName(undefined, "demo.apps.example.com"), "Demo");
    assert.equal(passkeyDisplayName("Demo", "demo.apps.example.com"), "Demo");
  });
});
