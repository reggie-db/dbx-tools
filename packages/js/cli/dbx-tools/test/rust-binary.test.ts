import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as rustBinary from "@dbx-tools/rust-binary";
import { buildProgram } from "../src/cli.ts";
import * as compatibility from "../src/rust-binary.ts";

describe("Rust release binaries", () => {
  it("registers generated commands without executing them", () => {
    const help = buildProgram().helpInformation();

    assert.match(help, /model-proxy/);
    assert.match(help, /lakebase-proxy/);
  });

  it("keeps the legacy subpath as an exact runtime re-export", () => {
    assert.equal(compatibility.ensureRustReleaseBinary, rustBinary.ensureRustReleaseBinary);
    assert.equal(compatibility.runRustReleaseBinary, rustBinary.runRustReleaseBinary);
    assert.equal(compatibility.rustReleaseBinaryCommand, rustBinary.rustReleaseBinaryCommand);
  });
});
