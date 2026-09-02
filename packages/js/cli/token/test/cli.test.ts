import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProgram } from "../src/cli.ts";

describe("token CLI", () => {
  it("fails foreground serve immediately when its secret is missing", async () => {
    await assert.rejects(
      () =>
        buildProgram("dbx token").parseAsync(["serve", "--no-bind-docker"], {
          from: "user",
        }),
      /Foreground serve requires --secret/,
    );
  });

  it("exposes only the client-jwt generator command", () => {
    const names = buildProgram("dbx token").commands.map((command) => command.name());

    assert.ok(names.includes("client-jwt"));
    assert.ok(!names.includes("client-token"));
  });
});
