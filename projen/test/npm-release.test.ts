import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { packNpmPackage } from "../src/npm-packaging.ts";
import {
  isNpmStagedVersionConflict,
  npmReleaseMatches,
  publishNpmArchive,
  readNpmArchiveIdentity,
  type NpmReleaseIdentity,
} from "../src/npm-release.ts";
import { materializeWorkspaceManifest } from "../src/workspace-manifest.ts";

let outdir: string;
let archive: string;
let identity: NpmReleaseIdentity;
let packageDir: string;
let dependencyDir: string;

before(() => {
  outdir = mkdtempSync(join(tmpdir(), "npm-release-"));
  packageDir = join(outdir, "package");
  mkdirSync(packageDir);
  dependencyDir = join(outdir, "dependency");
  mkdirSync(dependencyDir);
  writeFileSync(
    join(outdir, "package.json"),
    `${JSON.stringify({
      private: true,
      version: "1.2.3",
      workspaces: ["package", "dependency"],
    })}\n`,
  );
  writeFileSync(
    join(dependencyDir, "package.json"),
    `${JSON.stringify({ name: "@fixture/dependency", version: "1.2.3" })}\n`,
  );
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({
      name: "@fixture/native",
      version: "1.2.3",
      repository: "git+https://github.com/example/fixture.git",
      publishConfig: { access: "restricted" },
      dependencies: { "@fixture/dependency": "workspace:*" },
    })}\n`,
  );
  const installed = spawnSync("bun", ["install", "--ignore-scripts"], {
    cwd: outdir,
    stdio: "pipe",
  });
  assert.equal(installed.status, 0, installed.stderr.toString());
  archive = join(outdir, "fixture.tgz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", outdir, "package"]);
  assert.equal(packed.status, 0);
  identity = readNpmArchiveIdentity(archive);
});

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("npm release recovery", () => {
  it("materializes workspace protocols, catalog entries, and concrete overrides", () => {
    const resolved = materializeWorkspaceManifest(
      {
        dependencies: {
          "@fixture/dependency": "workspace:^",
          zod: "catalog:",
        },
        devDependencies: {
          "@typescript-eslint/parser": "^8",
        },
      },
      {
        version: "1.2.3",
        catalog: { zod: "4.3.6" },
        overrides: {
          "@typescript-eslint/parser": "8.71.0",
        },
      },
    );

    assert.deepEqual(resolved.dependencies, {
      "@fixture/dependency": "^1.2.3",
      zod: "4.3.6",
    });
    assert.deepEqual(resolved.devDependencies, {
      "@typescript-eslint/parser": "8.71.0",
    });
  });

  it("reads and matches an exact staged archive", () => {
    assert.equal(identity.name, "@fixture/native");
    assert.equal(identity.version, "1.2.3");
    assert.equal(identity.access, "restricted");
    assert.match(identity.integrity!, /^sha512-/);
    assert.equal(
      npmReleaseMatches(identity, {
        ...identity,
        repository: "https://github.com/example/fixture",
      }),
      true,
    );
  });

  it("packs a package into the requested directory", () => {
    const destination = join(outdir, "packed");
    mkdirSync(destination);
    const packed = packNpmPackage(packageDir, destination);
    assert.equal(readNpmArchiveIdentity(packed).name, "@fixture/native");
  });

  it("packs multiple packages into one requested directory", () => {
    const destination = join(outdir, "packed-workspace");
    mkdirSync(destination);

    const dependency = packNpmPackage(dependencyDir, destination);
    const native = packNpmPackage(packageDir, destination);

    assert.equal(readNpmArchiveIdentity(dependency).name, "@fixture/dependency");
    assert.equal(readNpmArchiveIdentity(native).name, "@fixture/native");
  });

  it("repacks transformed manifests without registry-invalid directory entries", () => {
    const destination = join(outdir, "packed-transformed");
    mkdirSync(destination);
    const packed = packNpmPackage(packageDir, destination, process.env.PATH, (value) => ({
      ...value,
      transformed: true,
    }));
    const entries = spawnSync("tar", ["-tzf", packed], { encoding: "utf8" });
    assert.equal(entries.status, 0, entries.stderr);
    assert.equal(
      entries.stdout
        .trim()
        .split("\n")
        .some((entry) => entry.endsWith("/")),
      false,
    );
    const packedManifest = spawnSync("tar", ["-xOf", packed, "package/package.json"], {
      encoding: "utf8",
    });
    assert.equal(packedManifest.status, 0, packedManifest.stderr);
    assert.equal(JSON.parse(packedManifest.stdout).transformed, true);
  });

  it("publishes an absent version", () => {
    assert.equal(npmReleaseMatches(identity, undefined), false);
  });

  it("matches equivalent package content despite different tar metadata", () => {
    const secondArchive = join(outdir, "fixture-second.tgz");
    const future = new Date(Date.now() + 120_000);
    utimesSync(join(packageDir, "package.json"), future, future);
    chmodSync(join(packageDir, "package.json"), 0o444);
    const packed = spawnSync("tar", ["-czf", secondArchive, "-C", outdir, "package"]);
    assert.equal(packed.status, 0);
    const second = readNpmArchiveIdentity(secondArchive);

    assert.equal(second.contentDigest, identity.contentDigest);
    assert.equal(npmReleaseMatches(second, identity), true);
  });

  it("packs a read-only workspace manifest without changing it", () => {
    const destination = join(outdir, "packed-read-only");
    const manifest = join(packageDir, "package.json");
    const contents = readFileSync(manifest);
    mkdirSync(destination);

    const packed = packNpmPackage(packageDir, destination);

    assert.equal(readNpmArchiveIdentity(packed).name, "@fixture/native");
    assert.deepEqual(readFileSync(manifest), contents);
    assert.equal(statSync(manifest).mode & 0o777, 0o444);
  });

  it("rejects an existing version with different content", () => {
    assert.throws(
      () =>
        npmReleaseMatches(identity, {
          ...identity,
          contentDigest: "sha512-different",
          integrity: "sha512-different",
        }),
      /content does not match/,
    );
  });

  it("rejects an existing version from another repository", () => {
    assert.throws(
      () =>
        npmReleaseMatches(identity, {
          ...identity,
          repository: "https://github.com/example/other",
        }),
      /repository does not match/,
    );
  });

  it("recognizes a staged-version publish conflict", () => {
    assert.equal(
      isNpmStagedVersionConflict(
        new Error(
          'npm error 409 Conflict - PUT https://registry.npmjs.org/@dbx-tools%2fshared-email - Cannot publish over previously staged version "0.9.160".',
        ),
      ),
      true,
    );
    assert.equal(isNpmStagedVersionConflict(new Error("npm error 409 Conflict - already exists")), false);
  });

  it("waits for a previously staged version instead of publishing again", async () => {
    const bin = join(outdir, "staged-bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "npm"),
      [
        "#!/usr/bin/env bun",
        "import { appendFileSync } from \"node:fs\";",
        `appendFileSync(${JSON.stringify(join(outdir, "npm-invocations"))}, "publish\\n");`,
        'process.stderr.write(\'npm error 409 Conflict - PUT https://registry.npmjs.org/@fixture%2fnative - Cannot publish over previously staged version "1.2.3".\\n\');',
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "npm"), 0o755);
    let lookups = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("tarballs.invalid")) {
        return new Response(readFileSync(archive));
      }
      lookups += 1;
      if (lookups < 3) return new Response(null, { status: 404 });
      return Response.json({
        name: identity.name,
        version: identity.version,
        repository: identity.repository,
        dist: { integrity: identity.integrity, tarball: "https://tarballs.invalid/package.tgz" },
      });
    };
    try {
      const outcome = await publishNpmArchive({
        archive,
        identity,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
        intervalMs: 1,
        timeoutMs: 1_000,
      });
      assert.equal(outcome, "staged");
      assert.equal(readFileSync(join(outdir, "npm-invocations"), "utf8").trim(), "publish");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not wait for an unpublished npm failure", async () => {
    const bin = join(outdir, "failed-bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "npm"),
      [
        "#!/usr/bin/env bun",
        "process.stderr.write('npm error 403 Forbidden\\n');",
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "npm"), 0o755);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 404 });
    try {
      await assert.rejects(
        publishNpmArchive({
          archive,
          identity,
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
          intervalMs: 1,
          timeoutMs: 50,
        }),
        /403 Forbidden/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
