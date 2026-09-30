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
 *   - `@dbx-tools/*` -> the exact version from the root `VERSION` file;
 *   - `catalog:`     -> the concrete version from the root `pnpm-workspace.yaml`;
 *   - `bun`          -> added as a dependency so the platform's pnpm install
 *                       fetches the runtime (research: pnpm installs, bun runs);
 *   - a `pnpm-workspace.yaml` carrying `allowBuilds` (esbuild/unrs-resolver/bun/
 *     onnxruntime-node...) so pnpm 10+ doesn't fail the build on their postinstalls;
 *   - `requirements.txt` installing the matching `dbx-tools-graphiti` release
 *     so the AppKit Graphiti plugin can launch its Python sidecar;
 *   - `app.yaml` copied unchanged; deployment-only command/env overrides live in
 *     `databricks.yml` under the app resource's `config`;
 *   - the client `dist/` copied in and the server `src/` + support files.
 *
 * Run: `bun stage-deploy.ts` from the server package dir.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { releaseCatalog } from "@dbx-tools/projen";
import { parse, stringify } from "yaml";

const serverDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(serverDir, "../../../..");
const clientDist = resolve(serverDir, "../../app/appkit-demo/dist");
const outDir = join(tmpdir(), "dbx-tools-deploy-app");
const pkg = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8")) as Record<
  string,
  unknown
>;
const version = typeof pkg.version === "string" ? pkg.version : "";
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`invalid example package version: ${version || "<empty>"}`);
}
const releaseGraph = JSON.parse(
  readFileSync(join(repoRoot, ".projen/release-units.json"), "utf8"),
) as releaseCatalog.ReleaseUnitGraph;
const releaseVersions = new Map(releaseGraph.units.map((unit) => [unit.id, unit.version]));

function releaseVersion(identity: string): string {
  const project = releaseGraph.projects.find(
    (candidate) => candidate.identity === identity && candidate.unit !== undefined,
  );
  const resolved = project?.unit ? releaseVersions.get(project.unit) : undefined;
  if (!resolved) throw new Error(`no release unit version for ${identity}`);
  return resolved;
}

// The root catalog: `catalog:` specifiers resolve to these concrete versions.
const rootWorkspace = parse(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8")) as {
  catalog?: Record<string, string>;
  allowBuilds?: Record<string, boolean>;
};
const catalog = rootWorkspace.catalog ?? {};
const allowBuilds = rootWorkspace.allowBuilds ?? {};

/** Resolve every `catalog:`/`workspace:*` specifier to a concrete, npm-installable one. */
function resolveDeps(deps: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(deps ?? {})) {
    if (spec.startsWith("workspace:")) {
      out[name] = name.startsWith("@dbx-tools/")
        ? releaseVersion(name)
        : spec.replace("workspace:", "");
    } else if (spec === "catalog:") {
      const resolved = catalog[name];
      if (!resolved) throw new Error(`no catalog entry for ${name}`);
      out[name] = resolved;
    } else {
      out[name] = spec;
    }
  }
  return out;
}

const deployPkg = {
  name: "dbx-tools-demo-app",
  version,
  private: true,
  type: "module",
  // Runtime deps only, all resolved to npm-installable specifiers. `bun` is added
  // so the platform's pnpm install fetches the runtime the command runs (`bun
  // src/launch.ts`). The public tunnel is `@dbx-tools/tunnel`, already a normal
  // dependency of the server (resolved through `resolveDeps` above), consumed
  // in-process via `tunnelInterceptor()` - no wrapper bin to inject.
  dependencies: {
    ...resolveDeps(pkg.dependencies as Record<string, string>),
    bun: "1.3.14",
  },
  // Keep the ambient TS types the server's imported `@dbx-tools/*` SOURCE needs at
  // runtime type-strip (bun runs .ts directly), resolved off the catalog too.
  devDependencies: resolveDeps(pkg.devDependencies as Record<string, string>),
};

// pnpm-workspace.yaml: no members (single-package deploy), but `allowBuilds` so
// pnpm 10+ runs the postinstalls the build needs (esbuild, unrs-resolver, bun,
// onnxruntime-node, appkit, ...). This is the research recipe's build gate.
const deployWorkspace = { allowBuilds };

// --- write the staged tree ---
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(serverDir, "src"), join(outDir, "src"), { recursive: true });
if (existsSync(join(serverDir, "shared")))
  cpSync(join(serverDir, "shared"), join(outDir, "shared"), { recursive: true });
if (existsSync(clientDist)) cpSync(clientDist, join(outDir, "client-dist"), { recursive: true });
writeFileSync(join(outDir, "package.json"), `${JSON.stringify(deployPkg, null, 2)}\n`);
writeFileSync(join(outDir, "pnpm-workspace.yaml"), stringify(deployWorkspace));
writeFileSync(
  join(outDir, "requirements.txt"),
  `dbx-tools-graphiti==${releaseVersion("dbx-tools-graphiti")}\n`,
);
cpSync(join(serverDir, "app.yaml"), join(outDir, "app.yaml"));
cpSync(join(serverDir, "databricks.yml"), join(outDir, "databricks.yml"));

console.log(`staged deploy at ${outDir}`);
console.log(`  @dbx-tools/* -> ${version}, catalog resolved, bun+pnpm-workspace added`);
console.log(`  dbx-tools-graphiti==${version} added as the Python sidecar`);
console.log(`  app.yaml copied unchanged; databricks.yml owns deployed command/env overrides`);
