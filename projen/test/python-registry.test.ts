import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  configuredPublishUrl,
  devpiRegistry,
  parseUvDefaultIndex,
  parseUvIndexes,
  parseUvPublishUrls,
  resolveLocalPypi,
} from "../tasks/python-registry.ts";

describe("local Python registry detection", () => {
  // devpiRegistry() consults the global uv config for an explicit publish-url,
  // so isolate every test from the developer's real ~/.config/uv/uv.toml by
  // pointing UV_CONFIG_FILE at a nonexistent path (and clearing UV_PUBLISH_URL).
  // Individual tests that exercise the configured-publish-url path override
  // UV_CONFIG_FILE with a temp file of their own.
  let savedConfig: string | undefined;
  let savedPublish: string | undefined;
  beforeEach(() => {
    savedConfig = process.env.UV_CONFIG_FILE;
    savedPublish = process.env.UV_PUBLISH_URL;
    process.env.UV_CONFIG_FILE = join(tmpdir(), "uv-config-does-not-exist.toml");
    delete process.env.UV_PUBLISH_URL;
  });
  afterEach(() => {
    if (savedConfig === undefined) delete process.env.UV_CONFIG_FILE;
    else process.env.UV_CONFIG_FILE = savedConfig;
    if (savedPublish === undefined) delete process.env.UV_PUBLISH_URL;
    else process.env.UV_PUBLISH_URL = savedPublish;
  });
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

  it("parses url -> publish-url from uv config blocks", () => {
    assert.deepEqual(
      parseUvPublishUrls(`
[[index]]
name = "corp"
url = "https://pypi-proxy.cloud.databricks.com/simple"

[[index]]
name = "devpi-local"
url = "http://localhost:3141/reggie/dev/+simple/"
default = true
publish-url = "http://localhost:3141/reggie/dev/"
`),
      new Map([["http://localhost:3141/reggie/dev/+simple/", "http://localhost:3141/reggie/dev/"]]),
    );
  });

  describe("with a configured publish-url in the global uv config", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "uv-cfg-"));
      const cfg = join(dir, "uv.toml");
      writeFileSync(
        cfg,
        `[[index]]
name = "corp"
url = "https://pypi-proxy.cloud.databricks.com/simple"

[[index]]
name = "devpi-local"
url = "http://localhost:3141/reggie/dev/+simple/"
default = true
publish-url = "http://localhost:3141/custom/publish/"
`,
      );
      process.env.UV_CONFIG_FILE = cfg;
    });

    it("uses the configured publish-url as the deploy target", () => {
      assert.equal(
        configuredPublishUrl("http://localhost:3141/reggie/dev/+simple/"),
        "http://localhost:3141/custom/publish/",
      );
    });

    it("devpiRegistry prefers the configured publish-url over the derived one", () => {
      assert.deepEqual(devpiRegistry("http://localhost:3141/reggie/dev/+simple/"), {
        indexUrl: "http://localhost:3141/reggie/dev/+simple/",
        publishUrl: "http://localhost:3141/custom/publish/",
      });
    });

    it("UV_PUBLISH_URL overrides even the config file", () => {
      process.env.UV_PUBLISH_URL = "http://localhost:3141/env/publish/";
      assert.equal(
        configuredPublishUrl("http://localhost:3141/reggie/dev/+simple/"),
        "http://localhost:3141/env/publish/",
      );
    });
  });
});
