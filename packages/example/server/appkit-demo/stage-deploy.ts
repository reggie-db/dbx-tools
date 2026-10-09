#!/usr/bin/env -S bun
/**
 * Stage a SELF-CONTAINED deploy directory for the Databricks App.
 *
 * The demo server is a workspace member: its `@dbx-tools/*` deps are `workspace:*`
 * and its third-party deps are `catalog:`. Neither resolves when the Databricks
 * Apps platform runs a standalone `pnpm install` on the uploaded source. This
 * script produces `<tmp>/dbx-tools-deploy-app/` - OUTSIDE the repo, because the
 * bundle CLI filters its upload through the enclosing worktree's `.gitignore`,
 * and this repo ignores every `dist` directory: staged under `<repo>/dist/`,
 * `bundle deploy` warned "There are no files to sync" and shipped an app with no
 * source. The staged tree holds:
 *
 *   - the demo's transitive runtime `@dbx-tools/*` dependency closure packed
 *     from local compiled artifacts and linked through `file:` archives;
 *   - `catalog:`     -> the concrete version from the root `pnpm-workspace.yaml`;
 *   - `bun`          -> added as a dependency so the platform's pnpm install
 *                       fetches the runtime (research: pnpm installs, bun runs);
 *   - Monty's Linux binding -> declared directly so npm cannot omit the
 *                       transitive optional native package;
 *   - a `pnpm-workspace.yaml` carrying `allowBuilds` (esbuild/unrs-resolver/bun/
 *     onnxruntime-node...) so pnpm 10+ doesn't fail the build on their postinstalls;
 *   - `requirements.txt` installing locally built workspace wheels so the
 *     AppKit Graphiti plugin can launch its Python sidecar without PyPI;
 *   - `app.yaml` copied unchanged; deployment-only command/env overrides live in
 *     `databricks.yml` under the app resource's `config`;
 *   - the client `dist/` copied in and the server `src/` + support files.
 *
 * Run: `bun stage-deploy.ts` from the server package dir.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPythonProjects } from "@dbx-tools/projen/python-release-packaging";
import { materializeWorkspaceManifest, packNpmPackage } from "@dbx-tools/projen/release-packaging";
import { parse, stringify } from "yaml";

const serverDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(serverDir, "../../../..");
const clientDist = resolve(serverDir, "../../app/appkit-demo/dist");
const outDir = join(tmpdir(), "dbx-tools-deploy-app");
const pythonBuildDir = join(repoRoot, ".tmp", "demo-deploy-python");
const pkg = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8")) as Record<
  string,
  unknown
>;
const version = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`invalid workspace version: ${version || "<empty>"}`);
}
if (pkg.version !== version) {
  throw new Error(
    `example package version ${String(pkg.version)} does not match VERSION ${version}`,
  );
}

const workspaceManifest = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
) as Record<string, unknown>;
const rootWorkspace = parse(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8")) as {
  allowBuilds?: Record<string, boolean>;
  catalog?: Record<string, string>;
  packages?: string[];
};
const allowBuilds = rootWorkspace.allowBuilds ?? {};
const montyVersion = rootWorkspace.catalog?.["@pydantic/monty"];
if (!montyVersion) throw new Error("workspace catalog has no @pydantic/monty version");
const overrides = workspaceManifest.overrides as Record<string, unknown> | undefined;
const bunVersion = overrides?.bun;
if (typeof bunVersion !== "string" || !bunVersion) {
  throw new Error("root package.json has no Bun version override");
}
const deployPkg = materializeWorkspaceManifest(
  {
    name: "dbx-tools-demo-app",
    version,
    private: true,
    type: "module",
    dependencies: {
      ...(pkg.dependencies as Record<string, string>),
      "@pydantic/monty-linux-x64-gnu": montyVersion,
      bun: bunVersion,
    },
  },
  workspaceManifest,
) as Record<string, unknown>;

interface WorkspacePackage {
  readonly directory: string;
  readonly manifest: Record<string, unknown>;
  readonly name: string;
}

const RUNTIME_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function workspacePackages(): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const workspacePath of rootWorkspace.packages ?? []) {
    const directory = resolve(repoRoot, workspacePath);
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const name = manifest.name;
    if (typeof name !== "string" || !name.startsWith("@dbx-tools/")) continue;
    packages.set(name, { directory, manifest, name });
  }
  return packages;
}

function dependencyNames(manifest: Record<string, unknown>): string[] {
  return RUNTIME_DEPENDENCY_FIELDS.flatMap((field) => {
    const dependencies = manifest[field];
    return dependencies && typeof dependencies === "object" ? Object.keys(dependencies) : [];
  });
}

function runtimeWorkspacePackages(
  rootManifest: Record<string, unknown>,
  available: Map<string, WorkspacePackage>,
): WorkspacePackage[] {
  const selected = new Map<string, WorkspacePackage>();
  const pending = dependencyNames(rootManifest).filter((name) => available.has(name));
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (selected.has(name)) continue;
    const workspacePackage = available.get(name);
    if (!workspacePackage) continue;
    selected.set(name, workspacePackage);
    pending.push(
      ...dependencyNames(workspacePackage.manifest).filter(
        (dependency) => available.has(dependency) && !selected.has(dependency),
      ),
    );
  }
  return [...selected.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function externalPeerDependencies(packages: readonly WorkspacePackage[]): Record<string, string> {
  const selected = new Set(packages.map((workspacePackage) => workspacePackage.name));
  const peers = new Map<string, string>();
  for (const workspacePackage of packages) {
    const manifest = materializeWorkspaceManifest(
      workspacePackage.manifest,
      workspaceManifest,
    ) as Record<string, unknown>;
    const dependencies = manifest.peerDependencies;
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const [name, value] of Object.entries(dependencies)) {
      if (selected.has(name)) continue;
      if (typeof value !== "string" || !value) {
        throw new Error(`${workspacePackage.name} has an invalid peer dependency on ${name}`);
      }
      const existing = peers.get(name);
      if (existing && existing !== value) {
        throw new Error(`conflicting runtime peer dependency for ${name}: ${existing} and ${value}`);
      }
      peers.set(name, value);
    }
  }
  return Object.fromEntries([...peers].sort(([left], [right]) => left.localeCompare(right)));
}

function stageWorkspacePackages(packages: readonly WorkspacePackage[]): Record<string, string> {
  const archiveDir = join(outDir, "vendor", "npm");
  mkdirSync(archiveDir, { recursive: true });
  return Object.fromEntries(
    packages.map((workspacePackage) => {
      const archive = packNpmPackage(workspacePackage.directory, archiveDir);
      return [workspacePackage.name, `file:./vendor/npm/${basename(archive)}`];
    }),
  );
}

function stagePythonWheels(): string[] {
  try {
    buildPythonProjects({
      output: pythonBuildDir,
      root: join(repoRoot, "packages/py"),
      version,
    });
    const wheelDir = join(outDir, "vendor", "python");
    mkdirSync(wheelDir, { recursive: true });
    const wheels = readdirSync(pythonBuildDir)
      .filter((file) => file.endsWith(".whl"))
      .sort();
    if (wheels.length === 0) throw new Error("local Python build produced no wheels");
    for (const wheel of wheels) cpSync(join(pythonBuildDir, wheel), join(wheelDir, wheel));
    return wheels.map((wheel) => `./vendor/python/${basename(wheel)}`);
  } finally {
    rmSync(pythonBuildDir, { recursive: true, force: true });
  }
}

// pnpm-workspace.yaml: no members (single-package deploy), but `allowBuilds` so
// pnpm 10+ runs the postinstalls the build needs (esbuild, unrs-resolver, bun,
// onnxruntime-node, appkit, ...). This is the research recipe's build gate.
const deployWorkspace = { allowBuilds };

// --- write the staged tree ---
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(serverDir, "src"), join(outDir, "src"), { recursive: true });
if (existsSync(join(serverDir, "shared"))) {
  cpSync(join(serverDir, "shared"), join(outDir, "shared"), { recursive: true });
}
if (existsSync(clientDist)) cpSync(clientDist, join(outDir, "client-dist"), { recursive: true });
const selectedPackages = runtimeWorkspacePackages(pkg, workspacePackages());
const dependencies = {
  ...externalPeerDependencies(selectedPackages),
  ...((deployPkg.dependencies as Record<string, string> | undefined) ?? {}),
  ...stageWorkspacePackages(selectedPackages),
};
const pythonRequirements = stagePythonWheels();
writeFileSync(
  join(outDir, "package.json"),
  `${JSON.stringify({ ...deployPkg, dependencies }, null, 2)}\n`,
);
writeFileSync(join(outDir, "pnpm-workspace.yaml"), stringify(deployWorkspace));
writeFileSync(join(outDir, "requirements.txt"), `${pythonRequirements.join("\n")}\n`);
cpSync(join(serverDir, "app.yaml"), join(outDir, "app.yaml"));
cpSync(join(serverDir, "databricks.yml"), join(outDir, "databricks.yml"));

console.log(`staged deploy at ${outDir}`);
console.log(`  ${selectedPackages.length} local @dbx-tools/* archives linked from ./vendor/npm`);
console.log(`  ${pythonRequirements.length} local Python wheels linked from ./vendor/python`);
console.log("  external catalog dependencies resolved; bun+pnpm-workspace added");
console.log(`  app.yaml copied unchanged; databricks.yml owns deployed command/env overrides`);
