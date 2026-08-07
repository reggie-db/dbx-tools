import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  devpiRegistry,
  parseUvDefaultIndex,
  parseUvIndexes,
  resolveLocalPypi,
} from "../tasks/python-registry.ts";

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

  it("reads every uv index, default first then extras in file order", () => {
    assert.deepEqual(
      parseUvIndexes(`
[[index]]
url = "https://pypi-proxy.cloud.databricks.com/simple/"
default = true

[[index]]
url = "http://localhost:3141/reggie/dev/+simple/"
`),
      [
        "https://pypi-proxy.cloud.databricks.com/simple/",
        "http://localhost:3141/reggie/dev/+simple/",
      ],
    );
  });

  it("auto-detects a local devpi added as an EXTRA index (corp proxy is primary)", () => {
    assert.deepEqual(
      resolveLocalPypi("auto", [
        "https://pypi-proxy.cloud.databricks.com/simple/",
        "http://localhost:3141/reggie/dev/+simple/",
      ]),
      {
        indexUrl: "http://localhost:3141/reggie/dev/+simple/",
        publishUrl: "http://localhost:3141/reggie/dev/",
      },
    );
  });

  it("returns undefined when no active index is a local devpi", () => {
    assert.equal(
      resolveLocalPypi("auto", [
        "https://pypi-proxy.cloud.databricks.com/simple/",
        "http://localhost:5000/index/",
      ]),
      undefined,
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
