import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { CliServiceDefinitionSchema, type CliServiceDefinition } from "./definition.ts";

export async function readServiceDefinition(path: string): Promise<CliServiceDefinition> {
  return CliServiceDefinitionSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function writeServiceDefinition(
  path: string,
  definition: CliServiceDefinition,
): Promise<void> {
  const parsed = CliServiceDefinitionSchema.parse(definition);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}
