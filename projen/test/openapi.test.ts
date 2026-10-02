import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  isOpenapiProducerSource,
  openapiWatchRoots,
  rustOpenapiArgs,
  speakeasyOpenapiAssetName,
} from "../src/openapi.ts";

describe("speakeasyOpenapiAssetName", () => {
  it("maps supported release targets", () => {
    assert.equal(speakeasyOpenapiAssetName("darwin", "arm64"), "openapi_Darwin_arm64.tar.gz");
    assert.equal(speakeasyOpenapiAssetName("linux", "x64"), "openapi_Linux_x86_64.tar.gz");
    assert.equal(speakeasyOpenapiAssetName("win32", "x64"), "openapi_Windows_x86_64.zip");
  });

  it("rejects unsupported release targets", () => {
    assert.throws(
      () => speakeasyOpenapiAssetName("aix", "ppc64"),
      /no supported release asset for aix\/ppc64/,
    );
  });
});

describe("Rust OpenAPI producers", () => {
  it("builds the Cargo export command from recorded producer options", () => {
    assert.deepEqual(
      rustOpenapiArgs(
        {
          crate: "fixture-api",
          rust: "packages/rs/api",
          output: "packages/js/openapi/api",
          binary: "fixture-server",
          features: ["metrics", "openapi"],
          noDefaultFeatures: true,
        },
        "/generated/openapi.json",
        "/generated/cargo-target",
      ),
      [
        "run",
        "--quiet",
        "--target-dir",
        "/generated/cargo-target",
        "--package",
        "fixture-api",
        "--no-default-features",
        "--features",
        "metrics,openapi",
        "--bin",
        "fixture-server",
        "--",
        "--generate-spec",
        "/generated/openapi.json",
      ],
    );
  });

  it("matches changed and deleted files by producer ownership", () => {
    const root = resolve("/workspace");
    const producer = join(root, "packages/rs/api");
    assert.equal(isOpenapiProducerSource(join(producer, "src/routes.rs"), [producer]), true);
    assert.equal(
      isOpenapiProducerSource(join(root, "packages/rs/other/src/lib.rs"), [producer]),
      false,
    );
  });

  it("watches producer roots without watching generated OpenAPI packages", () => {
    const roots = openapiWatchRoots();
    assert.ok(roots.some((root) => root.endsWith("/packages/rs/model-proxy/src")));
    assert.ok(roots.some((root) => root.endsWith("/packages/rs/model-proxy/Cargo.toml")));
    assert.equal(
      roots.some((root) => root.includes("/packages/js/openapi/")),
      false,
    );
  });
});
