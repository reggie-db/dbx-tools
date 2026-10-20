import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main, waitForPublications, type PublicationProbe } from "../tasks/verify-publications.ts";

describe("public release availability", () => {
  it("checks unresolved publications concurrently at the end of the batch", async () => {
    const attempts = new Map<string, number>();
    let active = 0;
    let maximumActive = 0;
    const probes: PublicationProbe[] = ["npm", "pypi"].map((label) => ({
      label,
      available: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(5);
        active -= 1;
        const attempt = (attempts.get(label) ?? 0) + 1;
        attempts.set(label, attempt);
        return attempt > 1;
      },
    }));

    await waitForPublications(probes, {
      concurrency: 2,
      intervalMs: 1,
      timeoutMs: 1_000,
    });

    assert.equal(maximumActive, 2);
    assert.deepEqual(Object.fromEntries(attempts), { npm: 2, pypi: 2 });
  });

  it("verifies exact npm and PyPI release artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "verify-publications-"));
    const originalFetch = globalThis.fetch;
    try {
      const npmDirectory = join(root, "npm");
      const npmPackage = join(root, "package");
      const pypiDirectory = join(root, "python");
      mkdirSync(npmDirectory);
      mkdirSync(npmPackage);
      mkdirSync(pypiDirectory);
      writeFileSync(
        join(npmPackage, "package.json"),
        JSON.stringify({
          name: "@fixture/core",
          version: "1.2.3",
          repository: "https://github.com/example/fixture",
        }),
      );
      const npmArchive = join(npmDirectory, "fixture-core.tgz");
      execFileSync("tar", ["-czf", npmArchive, "-C", root, "package"]);

      const wheel = join(pypiDirectory, "fixture_pkg-1.2.3-py3-none-any.whl");
      const source = join(pypiDirectory, "fixture-pkg-1.2.3.tar.gz");
      writeFileSync(wheel, "wheel");
      writeFileSync(source, "source");
      const pythonDigests = new Map(
        [wheel, source].map((path) => [
          path.split("/").at(-1)!,
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ]),
      );
      const npmArchiveBytes = readFileSync(npmArchive);
      const requested: string[] = [];
      globalThis.fetch = async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("registry.npmjs.org")) {
          return Response.json({
            name: "@fixture/core",
            version: "1.2.3",
            repository: "https://github.com/example/fixture",
            dist: { tarball: "https://tarballs.invalid/fixture-core.tgz" },
          });
        }
        if (url.includes("tarballs.invalid")) return new Response(npmArchiveBytes);
        if (url.includes("pypi.org")) {
          return Response.json({
            urls: [...pythonDigests].map(([filename, sha256]) => ({
              filename,
              digests: { sha256 },
            })),
          });
        }
        return new Response(null, { status: 404 });
      };

      await main([
        "--version",
        "1.2.3",
        "--npm-directory",
        npmDirectory,
        "--pypi-directory",
        pypiDirectory,
        "--interval-seconds",
        "0.001",
        "--timeout-seconds",
        "1",
      ]);

      assert.ok(requested.some((url) => url.includes("registry.npmjs.org")));
      assert.ok(requested.some((url) => url.includes("pypi.org/pypi/fixture-pkg/1.2.3/json")));
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
