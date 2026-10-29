import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { installServiceRuntime } from "../src/_runtime.ts";

describe("CLI service runtime installation", () => {
  it("preserves dependencies across concurrent installers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-runtime-"));
    const bunExecutable = await fakeBunInstaller(directory);

    await Promise.all([
      installServiceRuntime(bunExecutable, directory, { "package-a": "1.0.0" }),
      installServiceRuntime(bunExecutable, directory, { "package-b": "2.0.0" }),
    ]);

    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    assert.deepEqual(manifest.dependencies, {
      "package-a": "1.0.0",
      "package-b": "2.0.0",
    });
  });

  it("installs an identical dependency set once across concurrent callers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-runtime-"));
    const bunExecutable = await fakeBunInstaller(directory);
    const dependencies = { "package-a": "1.0.0" };

    await Promise.all([
      installServiceRuntime(bunExecutable, directory, dependencies),
      installServiceRuntime(bunExecutable, directory, dependencies),
    ]);

    assert.equal(await readFile(join(directory, "install.log"), "utf8"), "install\n");
  });
});

async function fakeBunInstaller(directory: string): Promise<string> {
  const executable = join(directory, "bun");
  await writeFile(
    executable,
    `#!/usr/bin/env bun
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.cwd();
await appendFile(join(directory, "install.log"), "install\\n");
const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
await Bun.sleep(50);
for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
  const packageDirectory = join(directory, "node_modules", ...name.split("/"));
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name, version }));
}
`,
  );
  await chmod(executable, 0o755);
  return executable;
}
