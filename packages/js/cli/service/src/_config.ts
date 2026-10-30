import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";
import { CliServiceDefinitionSchema, type CliServiceDefinition } from "./definition.ts";

const InstalledCliServiceDefinitionSchema = CliServiceDefinitionSchema.unwrap()
  .extend({
    hostExecutable: z
      .string()
      .min(1)
      .optional()
      .describe("Installed service host executable. Absent on legacy installations."),
  })
  .readonly();

export type InstalledCliServiceDefinition = z.infer<typeof InstalledCliServiceDefinitionSchema>;

export async function readServiceDefinition(path: string): Promise<InstalledCliServiceDefinition> {
  return InstalledCliServiceDefinitionSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function writeServiceDefinition(
  path: string,
  definition: CliServiceDefinition & { readonly hostExecutable: string },
): Promise<void> {
  const parsed = InstalledCliServiceDefinitionSchema.parse(definition);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}
