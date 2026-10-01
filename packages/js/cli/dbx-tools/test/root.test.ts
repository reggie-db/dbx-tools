import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findWorkspaceRoot } from "../src/root.ts";

describe("workspace root", () => {
  it("reuses the core project boundary resolver", async () => {
    const root = mkdtempSync(join(tmpdir(), "dbx-tools-root-"));
    const nested = join(root, "packages", "example");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".projenrc.ts"), "export {};\n");
    assert.equal(await findWorkspaceRoot(nested), root);
  });

  it("preserves the requested directory when no Projen workspace exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbx-tools-root-"));
    assert.equal(await findWorkspaceRoot(directory), directory);
  });
});
