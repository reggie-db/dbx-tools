# @dbx-tools/cli-args

Generate Commander flags, help text, parsed values, and argv from one Zod
object schema without installing the full `dbx` package.

## Bind and parse arguments

```ts
import { addArgs, parseArgs } from "@dbx-tools/cli-args";
import { Command } from "commander";
import { z } from "zod";

const OptionsSchema = z.object({
  port: z.coerce.number().default(3000).describe("Server listening port"),
  databaseUrl: z.string().url().describe("PostgreSQL connection string"),
});

const program = addArgs(new Command("demo"), OptionsSchema);
await program.parseAsync(process.argv);
const options = parseArgs(program, OptionsSchema);
```

Help defaults come from Zod and from layered `@dbx-tools/core` configuration
(environment, `.env`, bundle, and app YAML). Use `.meta({ env, flag, helpDefault })`
when a field needs an exact environment name, should stay off the flag list, or
should hide its default. A field with `helpDefault: false` defers layered
configuration loading until `parseArgs`, so rendering `--help` does not resolve
that value.

## Serialize options back to argv

```ts
import { serializeArgs } from "@dbx-tools/cli-args";

const argv = serializeArgs(OptionsSchema);
const fromValues = serializeArgs({ port: 8080, debug: false });
```

Schemas serialize their parsed defaults. Concrete objects serialize current
values. Boolean false becomes `--no-*`, arrays become repeated flags, and
listener addresses use the shared listen-address format.

Consuming commands define their schemas. This package binds Commander, help,
and argv serialization. Use Commander directly when a command doesn't use a
Zod object schema or layered [@dbx-tools/core](../../node/core)
configuration.

## Parse a source-module command

Executable modules can derive their command name from `import.meta.url` and
their help description from the root schema:

```ts
import { parseModuleArgv } from "@dbx-tools/cli-args";
import { z } from "zod";

const OptionsSchema = z
  .object({ check: z.boolean().default(false).describe("Verify generated output") })
  .describe("Verify generated files");

export function main(argv = process.argv.slice(2)): void {
  const options = parseModuleArgv(import.meta.url, OptionsSchema, argv, {
    environmentPrefix: "PROJEN",
    sources: ["env", "dotenv"],
  });
  // Run the command with options.
}
```

For a module named `verify-generated.ts`, the environment prefix is
`PROJEN_VERIFY_GENERATED`. The normal `@dbx-tools/core` scope and fallback
resolution still apply.
