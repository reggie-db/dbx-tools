import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { DatabricksFileSystem } from "../src/databricks-fs.ts";

/** Minimal UC Files mock for a rooted volume filesystem. */
function mockVolumeClient() {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>([
    "/Volumes",
    "/Volumes/main",
    "/Volumes/main/default",
    "/Volumes/main/default/assets",
  ]);

  const client = {
    files: {
      async download({ file_path }: { file_path: string }) {
        const bytes = files.get(file_path);
        if (!bytes) {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
        return {
          contents: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        };
      },
      async upload({
        file_path,
        contents,
      }: {
        file_path: string;
        contents: ReadableStream<Uint8Array>;
        overwrite?: boolean;
      }) {
        const reader = contents.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        files.set(file_path, new Uint8Array(merged));
      },
      async delete({ file_path }: { file_path: string }) {
        if (!files.delete(file_path)) {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
      },
      async createDirectory({ directory_path }: { directory_path: string }) {
        if (dirs.has(directory_path) || files.has(directory_path)) {
          throw Object.assign(new Error("already exists"), { statusCode: 409 });
        }
        dirs.add(directory_path);
      },
      async deleteDirectory({ directory_path }: { directory_path: string }) {
        if (!dirs.has(directory_path)) {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
        dirs.delete(directory_path);
      },
      async *listDirectoryContents({ directory_path }: { directory_path: string }) {
        if (!dirs.has(directory_path)) {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
        const prefix = `${directory_path}/`;
        for (const dir of dirs) {
          if (!dir.startsWith(prefix)) continue;
          const rest = dir.slice(prefix.length);
          if (!rest || rest.includes("/")) continue;
          yield { name: rest, path: dir, is_directory: true };
        }
        for (const [file, bytes] of files) {
          if (!file.startsWith(prefix)) continue;
          const rest = file.slice(prefix.length);
          if (!rest || rest.includes("/")) continue;
          yield { name: rest, path: file, is_directory: false, file_size: bytes.byteLength };
        }
      },
      async getMetadata({ file_path }: { file_path: string }) {
        const bytes = files.get(file_path);
        if (!bytes) throw Object.assign(new Error("not found"), { statusCode: 404 });
        return {
          "content-length": String(bytes.byteLength),
          "content-type": "application/octet-stream",
        };
      },
      async getDirectoryMetadata({ directory_path }: { directory_path: string }) {
        if (!dirs.has(directory_path)) {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
        return {};
      },
    },
  };

  return { client: client as unknown as WorkspaceClient, files, dirs };
}

describe("DatabricksFileSystem", () => {
  it("accepts catalog.schema.volume roots and writes nested files", async () => {
    const { client } = mockVolumeClient();
    const fs = new DatabricksFileSystem({
      root: "main.default.assets",
      client,
    });
    assert.equal(fs.root, "/Volumes/main/default/assets");
    assert.equal(fs.backend, "databricks");

    await fs.writeFile("notes/hello.txt", "hi");
    assert.equal(await fs.readFile("notes/hello.txt", { encoding: "utf8" }), "hi");
    assert.equal(await fs.exists("notes"), true);

    const listing = await fs.readdir("notes");
    assert.deepEqual(
      listing.map((e) => e.name),
      ["hello.txt"],
    );
  });

  it("expands ~ with an explicit userName", async () => {
    const { client } = mockVolumeClient();
    const fs = new DatabricksFileSystem({
      root: "~/notes",
      userName: "me@example.com",
      client,
    });
    assert.equal(fs.root, "/Workspace/Users/me@example.com/notes");
  });

  it("create() resolves ~ via currentUser.me()", async () => {
    const { client } = mockVolumeClient();
    (client as { currentUser: { me: () => Promise<{ userName: string }> } }).currentUser = {
      me: async () => ({ userName: "agent@databricks.com" }),
    };
    const fs = await DatabricksFileSystem.create({ root: "~", client });
    assert.equal(fs.root, "/Workspace/Users/agent@databricks.com");
  });

  it("closes a multi-block DBFS handle when an upload fails", async () => {
    let closes = 0;
    const client = {
      dbfs: {
        create: async () => ({ handle: 7 }),
        addBlock: async () => {
          throw new Error("upload failed");
        },
        close: async () => {
          closes += 1;
        },
      },
    } as unknown as WorkspaceClient;
    const fs = new DatabricksFileSystem({ root: "/dbfs/tmp", client });

    await assert.rejects(() => fs.writeFile("large.bin", Buffer.alloc(1024 * 1024 + 1)));
    assert.equal(closes, 1);
  });
});
