import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { hash } from "../index.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const original = globalThis.crypto;

const withCrypto = (value: unknown, body: () => void) => {
  Object.defineProperty(globalThis, "crypto", { value, configurable: true, writable: true });
  try {
    body();
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
};

describe("hash.id", () => {
  afterEach(() => {
    assert.equal(globalThis.crypto, original);
  });

  it("mints a v4 UUID from crypto.randomUUID when available", () => {
    assert.match(hash.id(), UUID_V4);
    assert.notEqual(hash.id(), hash.id());
  });

  it("returns a short hex slice when a length is given", () => {
    assert.match(hash.id(8), /^[0-9a-f]{8}$/);
    assert.equal(hash.id(1).length, 1);
  });

  it("rejects a non-positive length", () => {
    assert.throws(() => hash.id(0), /greater than 0/);
    assert.throws(() => hash.id(-1), /greater than 0/);
  });

  it("falls back to getRandomValues where randomUUID is absent (plain-http browser)", () => {
    withCrypto({ getRandomValues: original.getRandomValues.bind(original) }, () => {
      assert.match(hash.id(), UUID_V4);
      assert.notEqual(hash.id(), hash.id());
    });
  });

  it("falls back to Math.random where crypto is absent entirely", () => {
    withCrypto(undefined, () => {
      assert.match(hash.id(), UUID_V4);
      assert.match(hash.id(12), /^[0-9a-f]{12}$/);
    });
  });
});
