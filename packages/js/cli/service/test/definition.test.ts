import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

import { CliServiceDefinitionSchema, defineService } from "../src/definition.ts";

describe("CLI service definition", () => {
  it("derives package identity from the calling module URL", () => {
    const definition = defineService(import.meta.url, {
      icon: "/opt/example/icon.png",
    });

    assert.equal(definition.packageName, "@dbx-tools/cli-service");
    assert.equal(definition.id, "dbx-tools.cli-service");
    assert.equal(definition.name, "dbx service");
    assert.match(definition.version ?? "", /^\d+\.\d+\.\d+/);
  });

  it("accepts a tray, managed command, and URL item", () => {
    const definition = CliServiceDefinitionSchema.parse({
      id: "com.example.gateway",
      name: "Example Gateway",
      packageName: "@example/gateway",
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

  it("serializes command options from a Zod schema or concrete object", () => {
    const schemaDefinition = defineService(import.meta.url, {
      command: {
        options: z.object({
          host: z.string().default("127.0.0.1"),
          port: z.number().default(4000),
        }),
      },
    });
    assert.deepEqual(schemaDefinition.command?.arguments, [
      "--host",
      "127.0.0.1",
      "--port",
      "4000",
    ]);
    assert.deepEqual(schemaDefinition.command?.environment, { NODE_ENV: "production" });

    const objectDefinition = defineService(import.meta.url, {
      command: {
        arguments: ["serve"],
        environment: { NODE_ENV: "development", SAMPLE: "configured" },
        options: {
          host: "localhost",
          debug: true,
          managed: false,
          tags: ["one", "two"],
        },
      },
    });
    assert.deepEqual(objectDefinition.command?.arguments, [
      "serve",
      "--host",
      "localhost",
      "--debug",
      "--no-managed",
      "--tags",
      "one",
      "--tags",
      "two",
    ]);
    assert.deepEqual(objectDefinition.command?.environment, {
      NODE_ENV: "development",
      SAMPLE: "configured",
    });
  });

  it("rejects unsafe identifiers and URL protocols", () => {
    assert.throws(
      () =>
        CliServiceDefinitionSchema.parse({
          id: "../example",
          name: "Example",
          packageName: "@example/gateway",
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
          packageName: "@example/gateway",
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
          packageName: "@example/gateway",
          version: "1.0.0",
          icon: "/icon.png",
          command: {
            executable: "/opt/example",
            entrypoint: "/opt/example.ts",
          },
        }),
      /at most one/,
    );
  });
});
