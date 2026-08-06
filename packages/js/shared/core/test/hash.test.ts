import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Language, polygotTest } from "@dbx-tools/test-polyglot/polyglot";
import { PACKAGE_IDENTIFIER, hash } from "../index.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const original = globalThis.crypto;
const hashContract = {
  fnvHash(value: string, options: { length?: number } = {}): string {
    return hash.fnvHashWithOptions(options, value);
  },
};

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

await polygotTest(
  async () => ({ PACKAGE_IDENTIFIER, hash: hashContract }),
  "hash",
  (implementation, language) => {
    describe(`hash.fnvHash (${language})`, () => {
      it("uses the default digest length", () => {
        assert.equal(implementation.fnvHash("string:7:billing"), "1m8m64");
      });

      it("hashes joined stable keys", () => {
        assert.equal(implementation.fnvHash("string:7:billing\0string:4:prod"), "091p2g");
      });

      it("supports the maximum digest length", () => {
        assert.equal(implementation.fnvHash("string:7:billing", { length: 7 }), "1m8m64b");
      });

      it("allows a zero-length digest", () => {
        assert.equal(implementation.fnvHash("billing", { length: 0 }), "");
      });
    });
  },
  {
    identifiers: {
      [Language.Python]: "dbx_tools.core.hash",
    },
  },
);

describe("polygotTest package metadata", () => {
  it("requires PACKAGE_IDENTIFIER when Python inference needs it", async () => {
    await assert.rejects(
      polygotTest(
        async () => ({ hash }),
        "hash",
        () => undefined,
      ),
      /does not export string PACKAGE_IDENTIFIER/,
    );
  });

  it("does not require package metadata with an explicit Python identifier", async () => {
    const languages: Language[] = [];
    await polygotTest(
      async () => ({ hash }),
      "hash",
      (_implementation, language) => languages.push(language),
      { identifiers: { [Language.Python]: "dbx_tools.core.hash" } },
    );
    assert.deepEqual(languages, [Language.TS, Language.Python]);
  });

  it("accepts an explicit package identifier and loader", async () => {
    const languages: Language[] = [];
    await polygotTest(
      { packageIdentifier: "@dbx-tools/shared-core", loader: async () => ({ hash }) },
      "hash",
      (_implementation, language) => languages.push(language),
      { identifiers: { [Language.Python]: "dbx_tools.core.hash" } },
    );
    assert.deepEqual(languages, [Language.TS, Language.Python]);
  });
});

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
