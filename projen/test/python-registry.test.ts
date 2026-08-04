import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { devpiRegistry, parseUvDefaultIndex, resolveLocalPypi } from "../tasks/python-registry.ts";

describe("local Python registry detection", () => {
  it("reads uv's default index", () => {
    assert.equal(
      parseUvDefaultIndex(`
[[index]]
url = "https://example.invalid/simple/"

[[index]]
url = "http://localhost:3141/reggie/dev/+simple/"
default = true
`),
      "http://localhost:3141/reggie/dev/+simple/",
    );
  });

  it("derives the writable devpi index from +simple", () => {
    assert.deepEqual(devpiRegistry("http://127.0.0.1:3141/reggie/dev/+simple/"), {
      indexUrl: "http://127.0.0.1:3141/reggie/dev/+simple/",
      publishUrl: "http://127.0.0.1:3141/reggie/dev/",
    });
  });

  it("does not mistake proxpi for a writable index", () => {
    assert.equal(resolveLocalPypi("auto", "http://localhost:5000/index/"), undefined);
  });

  it("skips remote indexes in auto mode", () => {
    assert.equal(resolveLocalPypi("auto", "https://pypi.org/simple/"), undefined);
  });

  it("accepts an explicit writable devpi index", () => {
    assert.deepEqual(resolveLocalPypi("http://localhost:3141/reggie/dev/"), {
      indexUrl: "http://localhost:3141/reggie/dev/+simple/",
      publishUrl: "http://localhost:3141/reggie/dev/",
    });
  });
});
