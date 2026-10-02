import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  cargoIndexPath,
  generatePackageIndexes,
  normalizePythonPackage,
} from "./generate-package-indexes.mjs";

let output;

before(() => {
  output = mkdtempSync(join(tmpdir(), "package-indexes-"));
});

after(() => {
  rmSync(output, { recursive: true, force: true });
});

describe("package index generation", () => {
  it("normalizes package names and Cargo sparse paths", () => {
    assert.equal(normalizePythonPackage("DBX.Tools_Core"), "dbx-tools-core");
    assert.equal(cargoIndexPath("a"), "1/a");
    assert.equal(cargoIndexPath("ab"), "2/ab");
    assert.equal(cargoIndexPath("abc"), "3/a/abc");
    assert.equal(cargoIndexPath("dbx-tools-core"), "db/x-/dbx-tools-core");
  });

  it("builds Python and Cargo indexes from release assets", async () => {
    const wheel = Buffer.from("wheel");
    const crate = Buffer.from("crate");
    const wheelName = "dbx_tools_core-1.2.3-py3-none-any.whl";
    const crateName = "dbx-tools-core-1.2.3.crate";
    const manifest = {
      schemaVersion: 1,
      packages: [
        {
          asset: crateName,
          record: {
            name: "dbx-tools-core",
            vers: "1.2.3",
            deps: [
              {
                name: "dbx-tools-model",
                req: "^1.2.3",
                features: [],
                optional: false,
                default_features: true,
                target: null,
                kind: "normal",
                registry: "self",
              },
            ],
            cksum: createHash("sha256").update(crate).digest("hex"),
            features: {},
            features2: { default: [] },
            yanked: false,
            v: 2,
          },
        },
      ],
    };
    const bytes = new Map([
      ["asset://wheel", wheel],
      ["asset://crate", crate],
      ["asset://manifest", Buffer.from(JSON.stringify(manifest))],
    ]);
    const assets = [
      {
        name: wheelName,
        url: "asset://wheel",
        browser_download_url: `https://github.com/example/project/releases/download/v1.2.3/${wheelName}`,
      },
      {
        name: crateName,
        url: "asset://crate",
        browser_download_url: `https://github.com/example/project/releases/download/v1.2.3/${crateName}`,
      },
      {
        name: "cargo-index.json",
        url: "asset://manifest",
        browser_download_url:
          "https://github.com/example/project/releases/download/v1.2.3/cargo-index.json",
      },
    ];
    const fetchImpl = async (url) => {
      if (String(url).startsWith("https://api.github.com/")) {
        return new Response(JSON.stringify([{ draft: false, tag_name: "v1.2.3", assets }]));
      }
      const body = bytes.get(String(url));
      return body ? new Response(body) : new Response("", { status: 404 });
    };

    await generatePackageIndexes({
      repository: "example/project",
      siteUrl: "https://docs.example.com",
      base: "/",
      output,
      fetchImpl,
    });

    assert.match(
      readFileSync(join(output, "simple/dbx-tools-core/index.html"), "utf8"),
      new RegExp(`${wheelName}#sha256=`),
    );
    assert.deepEqual(JSON.parse(readFileSync(join(output, "cargo/config.json"), "utf8")), {
      dl: "https://docs.example.com/cargo/crates/{crate}/{crate}-{version}.crate",
    });
    const record = JSON.parse(
      readFileSync(join(output, "cargo/db/x-/dbx-tools-core"), "utf8").trim(),
    );
    assert.equal(record.deps[0].registry, null);
    assert.deepEqual(readFileSync(join(output, `cargo/crates/dbx-tools-core/${crateName}`)), crate);
  });
});
