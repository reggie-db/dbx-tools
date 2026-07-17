/**
 * Bootstrap a brand-new folder into a working dbx-tools workspace before projen runs.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { intro, outro } from "@clack/prompts";
import { exec } from "@dbx-tools/node-core";
import { resolvePnpmArgv, runPnpm } from "./pnpm";
import { rootLabel } from "./root";

const DEFAULT_PROJEN_SPECIFIER = "@dbx-tools/shared-projen";

const PROJENRC_TEMPLATE = `import { DBXToolsNodeProject } from "@dbx-tools/shared-projen";

const project = new DBXToolsNodeProject();
project.synth();
`;

/** Seed `pnpm-workspace.yaml` so the first \`pnpm add\` can allow esbuild non-interactively. */
const WORKSPACE_SEED = `packages: []
allowBuilds:
  esbuild: true
`;

/**
 * Turn an empty folder into a functioning dbx-tools workspace: `pnpm init`, seed
 * `pnpm-workspace.yaml`, add `projen`/`typescript`/`tsx` + the engine package,
 * write a minimal `.projenrc.ts`, synth once (with `PROJEN_DISABLE_POST`), then
 * install. Does not run barrels - run `dbxtools barrels` or a full projen synth
 * post-install to generate package barrels.
 */
export function bootstrapWorkspace(
  root: string,
  projenSpecifier: string = DEFAULT_PROJEN_SPECIFIER,
): void {
  intro(`Bootstrapping dbx-tools workspace in ${rootLabel(root)}`);

  if (!existsSync(join(root, "package.json"))) {
    runPnpm(["init"], root);
  }

  const workspaceFile = join(root, "pnpm-workspace.yaml");
  if (!existsSync(workspaceFile)) {
    writeFileSync(workspaceFile, WORKSPACE_SEED);
  }

  runPnpm(["add", "-D", "projen", "typescript@^5.9.3", "tsx@^4.23.0", projenSpecifier], root);

  const projenrc = join(root, ".projenrc.ts");
  if (!existsSync(projenrc)) {
    writeFileSync(projenrc, PROJENRC_TEMPLATE);
  }

  runSynth(root);

  runPnpm(["install", "--no-frozen-lockfile", "--force"], root);
  outro("Workspace ready - re-run dbxtools or add packages under workspaces/");
}

function runSynth(root: string): void {
  const [command, ...prefix] = resolvePnpmArgv();
  exec.spawnSync(command, [...prefix, "exec", "tsx", ".projenrc.ts"], {
    cwd: root,
    env: { ...process.env, PROJEN_DISABLE_POST: "true" },
    check: true,
  });
}
