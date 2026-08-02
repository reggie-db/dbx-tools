import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "@dbx-tools/shared-core";
import { configuredRsPackageRoots, generateRsPackages } from "../src/rs-packages.ts";
import { repoRoot } from "../src/packages.ts";
import { watchLoop } from "../src/watch.ts";

const logger = log.logger("projen:rs-packages");
const configuredRoots = configuredRsPackageRoots(repoRoot);
const roots = configuredRoots === false ? [] : configuredRoots;
const watchRoots = roots.map((root) => resolve(repoRoot, root)).filter(existsSync);

function generate(): void {
  const outputs = generateRsPackages({ projectRoot: repoRoot, roots });
  logger.success(`generated ${outputs.length} Rosetta module${outputs.length === 1 ? "" : "s"}`);
}

generate();

if (process.argv.includes("--watch")) {
  if (watchRoots.length) watchLoop("rs-packages", watchRoots, generate);
  else {
    logger.info("no Rosetta roots configured; watcher is idle");
    setInterval(() => {}, 2_147_483_647);
  }
}
