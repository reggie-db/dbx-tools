import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";
import { commanderReference, serviceReference, withCliReference } from "./cli-reference.mjs";
import { resolvePackageTypeScriptExports } from "./package-exports.mjs";
import { discoverJavaScriptPackages } from "./repository-docs.mjs";

const root = process.cwd();
const check = process.argv.includes("--check");
const python =
  process.env.PYTHON ??
  (fs.existsSync(path.join(root, ".venv/bin/python"))
    ? path.join(root, ".venv/bin/python")
    : "python3");
const pythonReferences = JSON.parse(
  execFileSync(python, ["docs/scripts/python-cli-reference.py"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: [path.join(root, "packages/py/graphiti/src"), process.env.PYTHONPATH]
        .filter(Boolean)
        .join(path.delimiter),
    },
  }),
);
const references = [];
for (const pkg of discoverJavaScriptPackages(root).filter((pkg) => pkg.group === "cli")) {
  const entry = resolvePackageTypeScriptExports(pkg.manifest).find(
    (entry) => entry.subpath === "./cli",
  );
  if (!entry) throw new Error(`${pkg.name} must export its owning CLI module`);
  const owner = await import(pathToFileURL(entry.file).href);
  if (typeof owner.buildProgram !== "function" && typeof owner.buildServiceCommand !== "function") {
    throw new Error(`${pkg.name} must expose its parser builder for documentation`);
  }
  const reference =
    typeof owner.buildProgram === "function"
      ? commanderReference(owner.buildProgram())
      : serviceReference(owner.buildServiceCommand);
  references.push({
    readme: pkg.readme,
    reference:
      pkg.name === "@dbx-tools/cli-graphiti"
        ? `${reference}\n\n### Forwarded Graphiti Options\n\n${pythonReferences.start}`
        : reference,
  });
}
references.push({
  readme: path.join(root, "packages/py/graphiti/README.md"),
  reference: pythonReferences.full,
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
