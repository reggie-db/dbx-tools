import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { c as createTar } from "tar";

import { bin } from "../index.ts";

/** Zip containing one executable at `nested/tool`. */
const EXECUTABLE_ZIP =
  "UEsDBBQAAAAAAAAAIQDihkXDEQAAABEAAAALAAAAbmVzdGVkL3Rvb2wjIS9iaW4vc2gKZXhpdCAwClBLAQIUAxQAAAAAAAAAIQDihkXDEQAAABEAAAALAAAAAAAAAAAAAADtgQAAAABuZXN0ZWQvdG9vbFBLBQYAAAAAAQABADkAAAA6AAAAAAA=";
const EXECUTABLE_SOURCE = '#!/bin/sh\necho "example version 1.2.3.patchdev"\n';

function executableUrl(source: string = EXECUTABLE_SOURCE): string {
  return `data:application/octet-stream;base64,${Buffer.from(source).toString("base64")}`;
}

async function serveFile(path: string): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const server = createServer(async (_request, response) => {
    response.end(await readFile(path));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/${basename(path)}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe("bin.parseVersion", () => {
  it("prefers deeper versions, then the highest version from stdout", () => {
    assert.equal(
      bin.parseVersion({
        stdout: "tool 99.7, dependency v1.2.3rc1, release 2.0.1.patchdev",
        stderr: "ignored fallback v300.0.0",
      }),
      "2.0.1.patchdev",
    );
    assert.equal(bin.parseVersion({ stdout: "supports v1 and 1.4", stderr: "" }), "1.4");
  });

  it("falls back to common Python-style versions on stderr", () => {
    assert.equal(bin.parseVersion({ stdout: "tool", stderr: "Python 3.13.5rc1" }), "3.13.5rc1");
  });
});

describe("bin.which", () => {
  it("checks PATH, caller locations, and default user locations in order", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-bin-which-"));
    const pathDir = join(root, "path");
    const fallbackDir = join(root, "fallback");
    const defaultDir = join(root, "home", ".local", "bin");
    await Promise.all([
      mkdir(pathDir, { recursive: true }),
      mkdir(fallbackDir, { recursive: true }),
      mkdir(defaultDir, { recursive: true }),
    ]);
    const pathExecutable = join(pathDir, "path-tool");
    const fallbackExecutable = join(fallbackDir, "fallback-tool");
    const defaultExecutable = join(defaultDir, "default-tool");
    await Promise.all([
      writeFile(pathExecutable, "#!/bin/sh\n"),
      writeFile(fallbackExecutable, "#!/bin/sh\n"),
      writeFile(defaultExecutable, "#!/bin/sh\n"),
    ]);
    await Promise.all([
      chmod(pathExecutable, 0o755),
      chmod(fallbackExecutable, 0o755),
      chmod(defaultExecutable, 0o755),
    ]);

    try {
      assert.equal(
        await bin.which("path-tool", {
          environment: { PATH: pathDir },
          locations: [fallbackDir],
        }),
        pathExecutable,
      );
      assert.equal(
        await bin.which("fallback-tool", {
          environment: { PATH: pathDir },
          locations: [fallbackDir],
        }),
        fallbackExecutable,
      );
      assert.equal(
        await bin.which("default-tool", {
          defaultLocations: true,
          environment: { PATH: "" },
          homeDir: join(root, "home"),
          platform: "linux",
        }),
        defaultExecutable,
      );
      assert.equal(
        await bin.which("missing-tool", {
          environment: { PATH: pathDir },
          locations: [fallbackDir],
        }),
        undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bin.ensure", () => {
  it("downloads an executable and reuses the installed path", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "dbx-bin-home-"));
    try {
      const installed = await bin.ensure("example", executableUrl(), {
        homeDir,
        minVersion: "1.2",
      });

      assert.equal(installed.root, join(homeDir, ".example"));
      assert.equal(installed.binDir, join(homeDir, ".example", "bin"));
      assert.equal(installed.path, join(homeDir, ".example", "bin", "example"));
      await access(installed.path, constants.X_OK);

      const reused = await bin.ensure(
        "example",
        () => {
          throw new Error("an existing executable must not resolve another download");
        },
        { homeDir, minVersion: "1.2.3" },
      );
      assert.deepEqual(reused, installed);

      const majorOnly = await bin.ensure(
        "example",
        () => {
          throw new Error("a partial minimum must reuse the installed binary");
        },
        { homeDir, minVersion: "1" },
      );
      assert.deepEqual(majorOnly, installed);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("checks again under the process lock before downloading", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "dbx-bin-lock-"));
    let resolutions = 0;
    const resolveUrl = async (): Promise<string> => {
      resolutions += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return executableUrl();
    };

    try {
      const [first, second, third] = await Promise.all([
        bin.ensure("example", resolveUrl, { homeDir }),
        bin.ensure("example", resolveUrl, { homeDir }),
        bin.ensure("example", resolveUrl, { homeDir }),
      ]);

      assert.equal(resolutions, 1);
      assert.deepEqual(second, first);
      assert.deepEqual(third, first);
      await access(first.path, constants.X_OK);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("replaces an installed binary below the minimum version", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "dbx-bin-min-"));
    const path = join(homeDir, ".example", "bin", "example");
    await mkdir(join(homeDir, ".example", "bin"), { recursive: true });
    await writeFile(path, '#!/bin/sh\necho "example 1.1"\n');
    await chmod(path, 0o755);
    let resolutions = 0;

    try {
      const installed = await bin.ensure(
        "example",
        () => {
          resolutions += 1;
          return executableUrl('#!/bin/sh\necho "example 1.3.5"\n');
        },
        { homeDir, minVersion: "1.2" },
      );

      assert.equal(resolutions, 1);
      assert.match(await readFile(installed.path, "utf8"), /1\.3\.5/);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("supports a custom version argument and parser", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-bin-version-"));
    const homeDir = join(root, "home with spaces");
    let parses = 0;
    const source = [
      "#!/bin/sh",
      'if [ "$1" != "version" ]; then exit 2; fi',
      'echo "release train alpha" >&2',
      "",
    ].join("\n");

    try {
      const installed = await bin.ensure("example", executableUrl(source), {
        homeDir,
        minVersion: "2",
        versionArgument: "version",
        versionParser: ({ stderr }) => {
          parses += 1;
          return stderr.includes("alpha") ? "2.1.0-dev.3" : undefined;
        },
      });

      assert.equal(parses, 2);
      await access(installed.path, constants.X_OK);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws when the renamed binary fails its final version check", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "dbx-bin-final-"));
    let parses = 0;
    try {
      await assert.rejects(
        bin.ensure("example", executableUrl(), {
          homeDir,
          versionParser: () => {
            parses += 1;
            return parses === 1 ? "1.2.3" : undefined;
          },
        }),
        /installed binary is invalid after rename/,
      );
      assert.equal(parses, 2);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("unpacks tar archives and lets a selector prepare the binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-bin-tar-"));
    const homeDir = join(root, "home");
    const fixture = join(root, "fixture");
    const archive = join(root, "example.tar.gz");
    await mkdir(join(fixture, "nested"), { recursive: true });
    const executable = join(fixture, "nested", "tool");
    await writeFile(executable, EXECUTABLE_SOURCE);
    await chmod(executable, 0o755);
    await createTar({ cwd: fixture, file: archive, gzip: true }, ["nested"]);
    const server = await serveFile(archive);

    try {
      const installed = await bin.ensure("example", server.url, {
        autoUnpackage: true,
        homeDir,
        selector: async ({ source }) => {
          const selected = join(source, "nested", "tool");
          await chmod(selected, 0o755);
          return selected;
        },
      });

      assert.equal(await readFile(installed.path, "utf8"), EXECUTABLE_SOURCE);
      await access(installed.path, constants.X_OK);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unpacks a single executable from a zip archive by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-bin-zip-"));
    const archive = join(root, "example.zip");
    await writeFile(archive, Buffer.from(EXECUTABLE_ZIP, "base64"));
    const server = await serveFile(archive);

    try {
      const installed = await bin.ensure("example", server.url, {
        autoUnpackage: true,
        homeDir: join(root, "home"),
        versionParser: () => "1.2.3",
      });

      assert.equal(await readFile(installed.path, "utf8"), "#!/bin/sh\nexit 0\n");
      await access(installed.path, constants.X_OK);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("makes a downloaded candidate executable before validating it", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "dbx-bin-mode-"));
    try {
      const installed = await bin.ensure("example", executableUrl(), {
        homeDir,
        selector: async ({ source }) => {
          await chmod(source, 0o644);
          return source;
        },
      });

      await access(installed.path, constants.X_OK);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
