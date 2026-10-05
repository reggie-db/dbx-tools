import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CliServiceDefinitionSchema } from "../src/definition.ts";

describe("CLI service definition", () => {
  it("accepts a tray, managed command, and URL item", () => {
    const definition = CliServiceDefinitionSchema.parse({
      id: "com.example.gateway",
      name: "Example Gateway",
      version: "1.2.3",
      icon: "/opt/example/icon.png",
      command: {
        entrypoint: "/opt/example/src/example.ts",
        arguments: ["serve"],
      },
      menu: [
        {
          type: "url",
          label: "Models",
          url: "http://127.0.0.1:4400/v1/models",
        },
      ],
    });

    assert.equal(definition.command?.arguments?.[0], "serve");
    assert.equal(definition.menu?.[0]?.type, "url");
  });

  it("rejects unsafe identifiers and URL protocols", () => {
    assert.throws(
      () =>
        CliServiceDefinitionSchema.parse({
          id: "../example",
          name: "Example",
          version: "1.0.0",
          icon: "/icon.png",
        }),
      /filesystem safe/,
    );
    assert.throws(
      () =>
        CliServiceDefinitionSchema.parse({
          id: "com.example.gateway",
          name: "Example",
          version: "1.0.0",
          icon: "/icon.png",
          menu: [{ type: "url", label: "Unsafe", url: "javascript:alert(1)" }],
        }),
      /HTTP, HTTPS, or mailto/,
    );
    assert.throws(
      () =>
        CliServiceDefinitionSchema.parse({
          id: "com.example.gateway",
          name: "Example",
          version: "1.0.0",
          icon: "/icon.png",
          command: {
            executable: "/opt/example",
            entrypoint: "/opt/example.ts",
          },
        }),
      /exactly one/,
    );
  });
});
