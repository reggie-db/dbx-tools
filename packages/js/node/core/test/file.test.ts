import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { file } from "../index.ts";

describe("cachedRecord", () => {
  it("caches parsed records, including empty records", () => {
    let calls = 0;
    const key = `test:${crypto.randomUUID()}`;
    const first = file.cachedRecord(key, () => {
      calls += 1;
      return {};
    });
    const second = file.cachedRecord(key, () => {
      calls += 1;
      return { changed: true };
    });
    assert.deepEqual(first, {});
    assert.equal(second, first);
    assert.equal(calls, 1);
  });

  it("caches an undefined result", () => {
    let calls = 0;
    const key = `test:${crypto.randomUUID()}`;
    assert.equal(
      file.cachedRecord(key, () => {
        calls += 1;
        return undefined;
      }),
      undefined,
    );
    assert.equal(
      file.cachedRecord(key, () => {
        calls += 1;
        return { found: true };
      }),
      undefined,
    );
    assert.equal(calls, 1);
  });
});
