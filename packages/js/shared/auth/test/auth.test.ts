import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AUTH_BASE_PATH, isAuthPath } from "../src/auth.ts";

describe("isAuthPath", () => {
  it("matches the auth route boundary only", () => {
    assert.equal(isAuthPath(AUTH_BASE_PATH), true);
    assert.equal(isAuthPath(`${AUTH_BASE_PATH}/status`), true);
    assert.equal(isAuthPath(`${AUTH_BASE_PATH}/status?fresh=true`), true);
    assert.equal(isAuthPath(`${AUTH_BASE_PATH}z/private`), false);
    assert.equal(isAuthPath(`${AUTH_BASE_PATH}-private`), false);
  });
});
