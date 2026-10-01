import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProgram } from "../src/cli.ts";

describe("model proxy CLI", () => {
  it("leaves lifecycle options, validation, and help to Rust", () => {
    const program = buildProgram();
    const help = program.helpInformation();

    assert.deepEqual(program.commands, []);
    assert.doesNotMatch(help, /config-dir|systray|purge|uninstall/);
    assert.equal(
      program.options.some((option) => option.flags.includes("--help")),
      false,
    );
  });

  it("keeps command construction lazy", () => {
    assert.doesNotThrow(() => buildProgram().helpInformation());
  });
});
