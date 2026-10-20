import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { srcFolderExports } from "../src/project-js.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("srcFolderExports", () => {
  it("discovers folder barrels and public stylesheets without module subpaths", () => {
    const directory = mkdtempSync(join(tmpdir(), "dbx-tools-project-js-"));
    temporaryDirectories.push(directory);
    mkdirSync(join(directory, "src", "react"), { recursive: true });
    mkdirSync(join(directory, "src", "_internal"), { recursive: true });
    writeFileSync(join(directory, "src", "client.ts"), "");
    writeFileSync(join(directory, "src", "styles.css"), "");
    writeFileSync(join(directory, "src", "view.tsx"), "");
    writeFileSync(join(directory, "src", "_private.ts"), "");
    writeFileSync(join(directory, "src", "types.d.ts"), "");
    writeFileSync(join(directory, "src", "react", "component.tsx"), "");
    writeFileSync(join(directory, "src", "_internal", "value.ts"), "");

    assert.deepEqual(
      srcFolderExports({ outdir: directory } as Parameters<typeof srcFolderExports>[0]),
      {
        "./react": "./index.react.ts",
        "./styles.css": "./src/styles.css",
      },
    );
  });
});
