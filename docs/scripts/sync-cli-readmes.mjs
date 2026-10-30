import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgv } from "@dbx-tools/cli-args";
import { format, resolveConfig } from "prettier";
import { z } from "zod";
import { commanderReference, serviceReference, withCliReference } from "./cli-reference.mjs";
import { resolvePackageTypeScriptExports } from "./package-exports.mjs";
import { discoverJavaScriptPackages } from "./repository-docs.mjs";

const root = process.cwd();
const CliReadmeSyncOptionsSchema = z.object({
  check: z
    .boolean()
    .default(false)
    .describe("Verify that generated CLI references are current")
    .meta({ env: [], short: false }),
});
const { check } = parseArgv(CliReadmeSyncOptionsSchema);
const references = [];
for (const pkg of discoverJavaScriptPackages(root).filter((pkg) => pkg.group === "cli")) {
  const manifest = JSON.parse(fs.readFileSync(pkg.manifest, "utf8"));
  const entries = resolvePackageTypeScriptExports(pkg.manifest);
  const entry =
    entries.find((candidate) => candidate.subpath === "./cli") ??
    entries.find((candidate) => candidate.subpath === ".");
  if (!entry) {
    if (manifest.bin) throw new Error(`${pkg.name} must export its CLI parser`);
    continue;
  }
  const owner = await import(pathToFileURL(entry.file).href);
  if (
    typeof owner.buildProgram !== "function" &&
    typeof owner.buildDocumentationProgram !== "function" &&
    typeof owner.buildServiceCommand !== "function"
  ) {
    if (!manifest.bin) continue;
    throw new Error(`${pkg.name} must expose its parser builder for documentation`);
  }
  const reference =
    typeof owner.buildDocumentationProgram === "function"
      ? commanderReference(await owner.buildDocumentationProgram())
      : typeof owner.buildProgram === "function"
        ? commanderReference(owner.buildProgram())
        : serviceReference(owner.buildServiceCommand);
  references.push({
    readme: pkg.readme,
    reference,
  });
}
const { createReleaseCommand } = await import(
  pathToFileURL(path.join(root, "projen/tasks/release.ts")).href
);
references.push({
  readme: path.join(root, "projen/README.md"),
  reference: commanderReference(createReleaseCommand()),
});

const stale = [];
for (const { readme, reference } of references) {
  const original = fs.readFileSync(readme, "utf8");
  const generated = await format(withCliReference(original, reference), {
    ...(await resolveConfig(readme)),
    filepath: readme,
  });
  if (original === generated) continue;
  if (check) stale.push(path.relative(root, readme));
  else fs.writeFileSync(readme, generated);
}
if (stale.length) {
  throw new Error(`CLI references are stale: ${stale.join(", ")}. Run bun run docs:cli.`);
}
console.log(
  `${check ? "Checked" : "Updated"} CLI references in ${references.length} package READMEs.`,
);
