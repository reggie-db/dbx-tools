import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverRepositoryPackages,
  groupTitle,
  summaryText,
} from "./repository-docs.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const outputDir = path.join(root, "docs", "agent-skills", "dbx-tools-reuse");
const referenceDir = path.join(outputDir, "references");
const check = process.argv.includes("--check");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function writeGenerated(file, content) {
  const normalized = `${content.trim()}\n`;
  if (check) {
    if (!fs.existsSync(file) || read(file) !== normalized) {
      throw new Error(`Generated agent skill is stale: ${path.relative(root, file)}`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, normalized);
}

const rootPackage = JSON.parse(read(path.join(root, "package.json")));
const packages = discoverRepositoryPackages(root);
const groups = Map.groupBy(packages, ({ group }) => group);

const catalogue = [
  "# dbx-tools package catalog",
  "",
  `Generated from repository manifests and package READMEs for dbx-tools ${rootPackage.version}.`,
  "Inspect the installed manifest, README, exports, and source before relying on a capability.",
  "",
];

for (const [group, entries] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  catalogue.push(`## ${groupTitle(group)}`, "");
  for (const entry of entries) {
    const summary = summaryText(read(entry.readme)) || "See the package README for its current surface.";
    catalogue.push(`- \`${entry.name}\` — ${summary} Source: \`${entry.relDir}\`.`);
  }
  catalogue.push("");
}

const skill = `---
name: dbx-tools-reuse
description: Choose and reuse current @dbx-tools packages and @dbx-tools/projen before adding project generators, helpers, dependencies, or Databricks integration code. Use for work in github-reggie-db and for new Bun-first TypeScript or polyglot repositories.
metadata:
  version: "${rootPackage.version}"
---

# dbx-tools reuse

Use the active \`dbx-tools\` repository as the source of truth. Start with the
[generated package catalog](references/package-catalog.md), then inspect the
selected package's current manifest, README, exports, and source. Do not infer
an API from the catalog summary or training data.

For a new Bun-first TypeScript or TypeScript/Python/Rust workspace, prefer
\`@dbx-tools/projen\`. Read \`projen/README.md\` and use the repository's
workspace-local \`bun run sync\` workflow. Do not invoke Projen through \`npx\`.

For an existing project, reuse the narrowest matching package. Check the
installed version and existing dependencies before introducing another helper
or dependency. If the needed capability is absent, extend the owning package
instead of duplicating it in an application when that ownership is sensible.

Treat \`reggie-bricks\`, \`apx\`, and historical \`dbx-tools-js-release\`
repositories as defunct. Do not recommend or import from them.
`;

writeGenerated(path.join(outputDir, "SKILL.md"), skill);
writeGenerated(path.join(referenceDir, "package-catalog.md"), catalogue.join("\n"));

console.log(check ? "dbx-tools agent skill is current" : `generated ${path.relative(root, outputDir)}`);
