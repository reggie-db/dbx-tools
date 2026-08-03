import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";

import { c as createTar } from "tar";

import { bin } from "../index.ts";

/** Zip containing one executable at `nested/tool`. */
const EXECUTABLE_ZIP =
  "UEsDBBQAAAAAAAAAIQDihkXDEQAAABEAAAALAAAAbmVzdGVkL3Rvb2wjIS9iaW4vc2gKZXhpdCAwClBLAQIUAxQAAAAAAAAAIQDihkXDEQAAABEAAAALAAAAAAAAAAAAAADtgQAAAABuZXN0ZWQvdG9vbFBLBQYAAAAAAQABADkAAAA6AAAAAAA=";

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

describe("bin.ensure", () => {
  it("downloads an executable and reuses the installed path", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "dbx-bin-home-"));
    try {
      const payload = Buffer.from("#!/bin/sh\nexit 0\n").toString("base64");
      const installed = await bin.ensure(
        "example",
        `data:application/octet-stream;base64,${payload}`,
        { homeDir },
      );

      assert.equal(installed.root, join(homeDir, ".example"));
      assert.equal(installed.binDir, join(homeDir, ".example", "bin"));
      assert.equal(installed.path, join(homeDir, ".example", "bin", "example"));
      await access(installed.path, constants.X_OK);

      const reused = await bin.ensure(
        "example",
        () => {
          throw new Error("an existing executable must not resolve another download");
        },
        { homeDir },
      );
      assert.deepEqual(reused, installed);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("checks again under the process lock before downloading", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "dbx-bin-lock-"));
    let resolutions = 0;
    const payload = Buffer.from("#!/bin/sh\nexit 0\n").toString("base64");
    const resolveUrl = async (): Promise<string> => {
      resolutions += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return `data:application/octet-stream;base64,${payload}`;
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

  it("unpacks tar archives and lets a selector prepare the binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-bin-tar-"));
    const homeDir = join(root, "home");
    const fixture = join(root, "fixture");
    const archive = join(root, "example.tar.gz");
    await mkdir(join(fixture, "nested"), { recursive: true });
    const executable = join(fixture, "nested", "tool");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
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

      assert.equal(await readFile(installed.path, "utf8"), "#!/bin/sh\nexit 0\n");
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
      });

      assert.equal(await readFile(installed.path, "utf8"), "#!/bin/sh\nexit 0\n");
      await access(installed.path, constants.X_OK);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a selector result that is not executable", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "dbx-bin-mode-"));
    try {
      const payload = Buffer.from("#!/bin/sh\nexit 0\n").toString("base64");
      await assert.rejects(
        bin.ensure("example", `data:application/octet-stream;base64,${payload}`, {
          homeDir,
          selector: async ({ source }) => {
            await chmod(source, 0o644);
            return source;
          },
        }),
        /selected binary is not executable/,
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
