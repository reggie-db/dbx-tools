import assert from "node:assert/strict";
import { chdir, cwd } from "node:process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { context } from "../index.ts";

afterEach(() => context.clear());

describe("context.cached", () => {
  it("loads once while the context is unchanged", () => {
    let calls = 0;
    const load = () => context.cached(["test", "stable"], () => ++calls);
    assert.equal(load(), 1);
    assert.equal(load(), 1);
    assert.equal(calls, 1);
  });

  it("passes the resolved context to the loader", () => {
    const seen = context.cached(["test", "resolved"], (value) => value);
    assert.equal(seen, cwd());
  });

  it("misses after the working directory moves", async () => {
    const original = cwd();
    const other = await realpath(await mkdtemp(join(tmpdir(), "dbx-tools-context-")));
    let calls = 0;
    try {
      assert.equal(
        context.cached(["test", "moved"], () => ++calls),
        1,
      );
      chdir(other);
      assert.equal(
        context.cached(["test", "moved"], () => ++calls),
        2,
      );
    } finally {
      chdir(original);
      await rm(other, { recursive: true, force: true });
    }
  });

  it("does not cache a value loaded for another directory", () => {
    let calls = 0;
    const load = () => context.cached(["test", "elsewhere"], () => ++calls, "/definitely/not/cwd");
    assert.equal(load(), 1);
    assert.equal(load(), 2);
  });

  it("treats \".\" and null as the current context", () => {
    let calls = 0;
    const load = (value?: string | null) =>
      context.cached(["test", "current"], () => ++calls, value);
    assert.equal(load(), 1);
    assert.equal(load("."), 1);
    assert.equal(load(null), 1);
    assert.equal(load(cwd()), 1);
  });

  it("evicts a rejected promise so a later call retries", async () => {
    let calls = 0;
    const load = () =>
      context.cached(["test", "rejected"], async () => {
        calls += 1;
        throw new Error("boom");
      });
    await assert.rejects(load());
    await assert.rejects(load());
    assert.equal(calls, 2);
  });
});

describe("context.isContext", () => {
  it("accepts the live working directory only", () => {
    assert.equal(context.isContext(cwd()), true);
    assert.equal(context.isContext("/definitely/not/cwd"), false);
    assert.equal(context.isContext("."), false);
    assert.equal(context.isContext(undefined), false);
  });
});
