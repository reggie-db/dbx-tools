# @dbx-tools/cli-args

Generate Commander flags from a Zod object schema so any CLI can share one
argument, help, and layered-config path without installing the full `dbx`
package.

## Bind And Parse Arguments

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
should hide its default.

## Serialize Options Back To Argv

```ts
import { serializeArgs } from "@dbx-tools/cli-args";

const argv = serializeArgs(OptionsSchema);
const fromValues = serializeArgs({ port: 8080, debug: false });
```

Schemas serialize their parsed defaults. Concrete objects serialize current
values. Boolean false becomes `--no-*`, arrays become repeated flags, and
listener addresses use the shared listen-address format.

Consuming commands own their schemas. This package only binds Commander, help,
and argv serialization.
