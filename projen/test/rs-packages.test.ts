import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { generateRsPackages } from "../src/rs-packages.ts";

function fixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "rs-packages-"));
  const dir = join(root, "rs-packages/shared/core/src");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "string.ts"), source);
  return root;
}

describe("rs-packages", () => {
  it("infers Node and Python output paths", () => {
    const root = fixture(`
export const capitalize = (value: string) => value.toUpperCase();

/* @rs-python
def capitalize(value: str) -> str:
    return value.upper()
@rs-end */
`);

    const [output] = generateRsPackages({ projectRoot: root });
    assert.equal(output?.node, join(root, "packages/shared/core/src/string.ts"));
    assert.equal(
      output?.python,
      join(root, "python-packages/shared-core/src/shared_core/string.py"),
    );
    assert.match(readFileSync(output!.node, "utf8"), /export const capitalize/);
    assert.doesNotMatch(readFileSync(output!.node, "utf8"), /@rs-python/);
    assert.match(readFileSync(output!.python, "utf8"), /def capitalize/);
  });

  it("supports explicit output overrides", () => {
    const root = fixture(`
// @rs-node generated/node/string.ts
// @rs-python-path generated/python/string.py
export const value = "node";
/* @rs-python
value = "python"
@rs-end */
`);

    const [output] = generateRsPackages({ projectRoot: root });
    assert.equal(output?.node, join(root, "generated/node/string.ts"));
    assert.equal(output?.python, join(root, "generated/python/string.py"));
  });

  it("rejects sources without a Python implementation", () => {
    const root = fixture("export const nodeOnly = true;\n");
    assert.throws(
      () => generateRsPackages({ projectRoot: root }),
      /needs at least one \/\* @rs-python/,
    );
  });

  it("does not overwrite a hand-authored target", () => {
    const root = fixture(`
export const generated = true;
/* @rs-python
generated = True
@rs-end */
`);
    const target = join(root, "packages/shared/core/src/string.ts");
    mkdirSync(join(root, "packages/shared/core/src"), { recursive: true });
    writeFileSync(target, "export const handAuthored = true;\n");

    assert.throws(
      () => generateRsPackages({ projectRoot: root }),
      /Refusing to overwrite hand-authored Rosetta output/,
    );
    assert.equal(readFileSync(target, "utf8"), "export const handAuthored = true;\n");
  });
});
