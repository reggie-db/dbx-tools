import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { srcModuleExports } from "../src/project-js.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("srcModuleExports", () => {
  it("discovers public files and directory entrypoints", () => {
    const directory = mkdtempSync(join(tmpdir(), "dbx-tools-project-js-"));
    temporaryDirectories.push(directory);
    mkdirSync(join(directory, "src", "react"), { recursive: true });
    mkdirSync(join(directory, "src", "internal"), { recursive: true });
    writeFileSync(join(directory, "src", "client.ts"), "");
    writeFileSync(join(directory, "src", "styles.css"), "");
    writeFileSync(join(directory, "src", "view.tsx"), "");
    writeFileSync(join(directory, "src", "_private.ts"), "");
    writeFileSync(join(directory, "src", "types.d.ts"), "");
    writeFileSync(join(directory, "src", "react", "index.ts"), "");
    writeFileSync(join(directory, "src", "internal", "value.ts"), "");

    assert.deepEqual(
      srcModuleExports({ outdir: directory } as Parameters<typeof srcModuleExports>[0]),
      {
        "./client": "./src/client.ts",
        "./react": "./src/react/index.ts",
        "./styles.css": "./src/styles.css",
        "./view": "./src/view.tsx",
      },
    );
  });
});
