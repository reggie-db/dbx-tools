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
    const commands = buildProgram("dbx token").commands;
    const names = commands.map((command) => command.name());
    const clientJwt = commands.find((command) => command.name() === "client-jwt");

    assert.ok(names.includes("client-jwt"));
    assert.ok(!names.includes("client-token"));
    assert.equal(clientJwt?.registeredArguments[0]?.required, false);
  });
});
