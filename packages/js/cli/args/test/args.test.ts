import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { options as sharedOptions } from "@dbx-tools/shared-core";
import { Command } from "commander";
import { z } from "zod";
import { addArgs, parseArgs, serializeArgs } from "../src/args.ts";

const schema = z.object({
  port: z.coerce.number().default(3000).describe("Server listening port"),
  databaseUrl: z.string().url().describe("PostgreSQL database connection string"),
  debug: z.boolean().default(false).describe("Enable verbose debug logging"),
  tags: z.array(z.string()).default([]).describe("Repeatable tag values"),
  mode: z.enum(["json", "text"]).default("json").describe("Output format"),
});

const isolated = {
  scope: [] as const,
  sources: ["env", "dotenv"] as const,
};

describe("addArgs", () => {
  it("derives flags, environment names, choices, and defaults", () => {
    const help = addArgs(new Command("demo"), schema, isolated).helpInformation();
    assert.match(help, /--database-url <value>/);
    assert.match(help, /DATABASE_URL/);
    assert.match(help, /--no-debug/);
    assert.match(help, /choices: "json", "text"/);
    assert.match(help, /default: 3000/);
  });

  it("documents unscoped environment names while still applying a prefix", () => {
    const help = addArgs(new Command("demo"), schema).helpInformation();
    assert.match(help, /DATABASE_URL/);
    assert.doesNotMatch(help, /DBX_TOOLS_DATABASE_URL/);
    const prefixed = addArgs(new Command("demo"), schema, { prefix: "FALKORDB" }).helpInformation();
    assert.match(prefixed, /FALKORDB_DATABASE_URL/);
    assert.doesNotMatch(prefixed, /DBX_TOOLS_FALKORDB_DATABASE_URL/);
  });

  it("renders layered dotenv values as help defaults", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cli-args-"));
    try {
      writeFileSync(join(cwd, ".env"), "PORT=4123\nDEBUG=true\n");
      const help = addArgs(new Command("demo"), schema, { ...isolated, cwd }).helpInformation();
      assert.match(help, /default: "4123"/);
      assert.match(help, /default: true/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses metadata env overrides and supports env-only fields", async () => {
    const configured = z.object({
      profile: z
        .string()
        .optional()
        .describe("Databricks profile")
        .meta({ env: "DATABRICKS_CONFIG_PROFILE", helpDefault: false }),
      host: z
        .string()
        .optional()
        .describe("Databricks host")
        .meta({ env: "DATABRICKS_HOST", flag: false }),
    });
    const previousProfile = process.env.DATABRICKS_CONFIG_PROFILE;
    const previous = process.env.DATABRICKS_HOST;
    process.env.DATABRICKS_CONFIG_PROFILE = "SENSITIVE-PROFILE";
    process.env.DATABRICKS_HOST = "https://workspace.example.com";
    try {
      const command = addArgs(new Command("demo").exitOverride(), configured, {
        scope: [],
        sources: ["env"],
      });
      const help = command.helpInformation();
      assert.match(help, /DATABRICKS_CONFIG_PROFILE/);
      assert.doesNotMatch(help, /SENSITIVE-PROFILE/);
      assert.doesNotMatch(help, /--host/);
      await command.parseAsync([], { from: "user" });
      assert.deepEqual(parseArgs(command, configured), {
        profile: "SENSITIVE-PROFILE",
        host: "https://workspace.example.com",
      });
    } finally {
      if (previousProfile === undefined) delete process.env.DATABRICKS_CONFIG_PROFILE;
      else process.env.DATABRICKS_CONFIG_PROFILE = previousProfile;
      if (previous === undefined) delete process.env.DATABRICKS_HOST;
      else process.env.DATABRICKS_HOST = previous;
    }
  });
});

describe("parseArgs", () => {
  it("prefers flags over layered configuration and applies schema defaults", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cli-args-"));
    try {
      writeFileSync(join(cwd, ".env"), "PORT=4123\nDATABASE_URL=postgres://env.example/db\n");
      const parsed = await parse(schema, { ...isolated, cwd }, [
        "--port",
        "8080",
        "--database-url",
        "postgres://cli.example/db",
        "--tags",
        "one",
      ]);
      assert.deepEqual(parsed, {
        port: 8080,
        databaseUrl: "postgres://cli.example/db",
        debug: false,
        tags: ["one"],
        mode: "json",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("parses listener addresses from one value", async () => {
    const configured = z.object({
      listen: sharedOptions.listenAddressSchema({ port: 4000 }),
    });
    assert.deepEqual(await parse(configured, isolated, ["--listen", ":4400"]), {
      listen: { scheme: "tcp", host: "localhost", port: 4400 },
    });
  });
});

describe("serializeArgs", () => {
  it("omits schema fields with disabled flags", () => {
    const configured = z.object({
      profile: z.string().default("DEFAULT"),
      host: z.string().default("workspace.example.com").meta({ flag: false }),
    });
    assert.deepEqual(serializeArgs(configured), ["--profile", "DEFAULT"]);
  });

  it("serializes scalars, booleans, arrays, and listener addresses", () => {
    assert.deepEqual(
      serializeArgs({
        listen: { scheme: "tcp", host: "localhost", port: 4400 },
        debug: true,
        managed: false,
        tags: ["one", "two"],
      }),
      [
        "--listen",
        "tcp://localhost:4400",
        "--debug",
        "--no-managed",
        "--tags",
        "one",
        "--tags",
        "two",
      ],
    );
  });
});

async function parse<T extends z.ZodRawShape>(
  value: z.ZodObject<T>,
  options: Parameters<typeof addArgs>[2],
  argv: string[],
): Promise<z.output<z.ZodObject<T>>> {
  let parsed: z.output<z.ZodObject<T>> | undefined;
  const command = addArgs(new Command("demo").exitOverride(), value, options).action(
    (_options: unknown, action: Command) => {
      parsed = parseArgs(action, value);
    },
  );
  await command.parseAsync(argv, { from: "user" });
  assert.ok(parsed);
  return parsed;
}
