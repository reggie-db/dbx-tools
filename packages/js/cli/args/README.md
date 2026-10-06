# @dbx-tools/cli-args

Bind Zod object fields to Commander flags, environment bindings, layered local
config, help defaults, and service arguments.

## Bind A Schema

```ts
import { addArgs, parseArgs } from "@dbx-tools/cli-args/args";
import { Command } from "commander";
import { z } from "zod";

const ConfigSchema = z.object({
  port: z.coerce.number().default(3000).describe("Server listening port"),
  debug: z.boolean().default(false).describe("Enable verbose debug logging"),
});

const command = addArgs(new Command("demo"), ConfigSchema, { scope: [] });
command.action(() => {
  const config = parseArgs(command, ConfigSchema);
  process.stdout.write(`${JSON.stringify(config)}\n`);
});
```

Field names derive `--kebab-case` flags and `UPPER_SNAKE_CASE` environment
names. Add `.meta({ env: "EXACT_NAME" })` for an established environment name.
Add `.meta({ env: "EXACT_NAME", flag: false })` for config that should remain
environment-only.

`configUtils` resolves process environment, `.env`, bundle App env, and
`app.yaml` values before Zod performs the final parse.

## Serialize Service Arguments

`serializeArgs` converts schema defaults or a concrete option object into an
argument array. Boolean values become positive or negated flags, arrays become
repeated flags, and listener addresses become `host:port`.
