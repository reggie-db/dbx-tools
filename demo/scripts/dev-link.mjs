#!/usr/bin/env node
/**
 * Toggle the demo between its two dependency-resolution modes for the
 * `@dbx-tools/*` packages:
 *
 *   - DEFAULT (consumer): packages install from the registry in `.npmrc`
 *     (a local verdaccio), as any downstream app would. Source changes in the
 *     main repo only appear after bump -> publish -> `pnpm update`.
 *   - DEV-LINK (this script): the repo's `../workspaces/**` are added as
 *     members of the demo's pnpm workspace and the demo's `@dbx-tools/*` deps
 *     are switched to `workspace:*`. pnpm then links them like any workspace
 *     member - crucially resolving their PEER deps (e.g. `@databricks/appkit-ui`)
 *     into the demo tree correctly, which a bare `link:` override does not.
 *     The running watchers (`vite` client, `tsx watch` server) then hot-reload
 *     main-repo edits with no republish or restart.
 *
 * Usage:
 *   node demo/scripts/dev-link.mjs            # link workspace source
 *   node demo/scripts/dev-link.mjs --unlink   # restore the registry consumer
 *
 * All edits are marked so `--unlink` reverses exactly what was added. This is
 * transient LOCAL dev state - run `--unlink` (or discard the changes) before
 * committing; the committed demo always stays a clean registry consumer.
 *
 * Discovery is dynamic: the workspace glob covers every package under
 * `../workspaces`, and the dep switch reads the on-disk `@dbx-tools/*` names,
 * so packages added / removed / renamed need no edit here.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const demoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = path.resolve(demoRoot, "..");
const workspaceYaml = path.join(demoRoot, "pnpm-workspace.yaml");

const read = (p) => fs.readFileSync(p, "utf8");
const readJson = (p) => JSON.parse(read(p));

// npm scope discovered from the demo's own package name (`@dbx-tools/demo` ->
// `@dbx-tools/`) so a project-wide rename needs no edit here.
const scope = `${readJson(path.join(demoRoot, "package.json")).name.split("/")[0]}/`;

// Workspace glob (relative to demo/) that pulls the repo's packages in as
// members, and the marker line that lets `--unlink` find + remove it.
const MEMBER_GLOB = `${path.relative(demoRoot, path.join(repoRoot, "workspaces"))}/*/*`;
const MARK = "# dbx-tools:dev-link";
// Sidecar recording each dep's pre-link specifier, so `--unlink` restores the
// exact ranges rather than guessing. Written on link, deleted on unlink.
const stateFile = path.join(demoRoot, ".dev-link.json");

/** The demo's own package manifests (the workspace members that declare deps). */
function demoMemberManifests() {
  return ["app/appkit-demo/package.json", "server/appkit-demo/package.json"]
    .map((rel) => path.join(demoRoot, rel))
    .filter((p) => fs.existsSync(p));
}

function pnpmInstall() {
  execFileSync("pnpm", ["install", "--no-frozen-lockfile"], {
    cwd: demoRoot,
    stdio: "inherit",
  });
}

// A repo-workspace `@dbx-tools/*` dep (not the demo's own `@dbx-tools/demo-*`
// packages, which don't live under ../workspaces and keep their specifier).
const isLinkableDep = (name) => name.startsWith(scope) && !name.startsWith(`${scope}demo`);

/**
 * Parse the simple `catalog:` block (one `  key: value` per line) out of a
 * `pnpm-workspace.yaml`. Only the flat default catalog is read - enough to
 * merge the main repo's catalog into the demo's so the linked member packages'
 * `catalog:` dependency specifiers resolve.
 */
function parseCatalog(yaml) {
  const out = {};
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === "catalog:");
  if (start === -1) return out;
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line) || line.trim() === "") break; // dedented -> block ended
    const m = line.match(/^\s+("?[^":]+"?):\s*(.+?)\s*$/);
    if (m) out[m[1].replace(/"/g, "")] = m[2];
  }
  return out;
}

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"];

function link() {
  // 1. Add the repo's packages as workspace members, and merge the main repo's
  //    catalog entries the linked packages reference (their deps use
  //    `catalog:` specifiers that must resolve against the demo's catalog).
  let yaml = read(workspaceYaml);
  const pristineYaml = yaml;
  if (!yaml.includes(MARK)) {
    yaml = yaml.replace(/^packages:\n/m, `packages:\n  - "${MEMBER_GLOB}" ${MARK}\n`);
    const demoCatalog = parseCatalog(yaml);
    const repoCatalog = parseCatalog(read(path.join(repoRoot, "pnpm-workspace.yaml")));
    // Demo entries win on conflict; add only the ones the demo lacks.
    const additions = Object.entries(repoCatalog).filter(([k]) => !(k in demoCatalog));
    if (additions.length > 0) {
      // Quote any key that isn't a plain YAML scalar - notably `@scope/...`
      // keys, which YAML requires quoted (a leading `@` is a reserved
      // indicator). Keep the mark as a trailing comment for `--unlink`.
      const block = additions
        .map(([k, v]) => `  ${/^[a-z0-9_.-]+$/i.test(k) ? k : `"${k}"`}: ${v} ${MARK}`)
        .join("\n");
      yaml = yaml.replace(/^catalog:\n/m, `catalog:\n${block}\n`);
    }
    fs.writeFileSync(workspaceYaml, yaml);
  }
  // 2. Point the demo's @dbx-tools/* deps at the workspace members, recording
  //    each prior specifier in the sidecar so `--unlink` restores it exactly.
  const prior = {};
  for (const manifestPath of demoMemberManifests()) {
    const manifest = readJson(manifestPath);
    const rel = path.relative(demoRoot, manifestPath);
    for (const field of DEP_FIELDS) {
      const deps = manifest[field];
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        if (isLinkableDep(name) && !deps[name].startsWith("workspace:")) {
          prior[`${rel}\t${field}\t${name}`] = deps[name];
          deps[name] = "workspace:*";
        }
      }
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  // Sidecar holds the pristine workspace file + the prior dep specifiers, so
  // `--unlink` restores both exactly. It's the only file this script leaves
  // behind, and it's already gitignored.
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ workspaceYaml: pristineYaml, deps: prior }, null, 2)}\n`,
  );
  console.log(
    "dev-link: added ../workspaces/* as members and switched deps to workspace:*. Installing...",
  );
  pnpmInstall();
  console.log("dev-link: done. Run the watchers; edits under ../workspaces/**/src hot-reload.");
}

function unlink() {
  const state = fs.existsSync(stateFile) ? readJson(stateFile) : {};
  // 1. Restore the pristine workspace file (drops both the member glob and the
  //    merged catalog entries in one shot). Fall back to stripping marked
  //    lines if the sidecar is missing.
  if (typeof state.workspaceYaml === "string") {
    fs.writeFileSync(workspaceYaml, state.workspaceYaml);
  } else {
    const yaml = read(workspaceYaml)
      .split("\n")
      .filter((line) => !line.includes(MARK))
      .join("\n");
    fs.writeFileSync(workspaceYaml, yaml);
  }
  // 2. Restore each dep's pre-link specifier (falling back to "*" if unknown).
  const prior = state.deps ?? {};
  for (const manifestPath of demoMemberManifests()) {
    const manifest = readJson(manifestPath);
    const rel = path.relative(demoRoot, manifestPath);
    for (const field of DEP_FIELDS) {
      const deps = manifest[field];
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        if (isLinkableDep(name) && deps[name].startsWith("workspace:")) {
          deps[name] = prior[`${rel}\t${field}\t${name}`] ?? "*";
        }
      }
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  fs.rmSync(stateFile, { force: true });
  console.log("dev-link: removed workspace members + restored deps. Reinstalling...");
  pnpmInstall();
  console.log("dev-link: done. @dbx-tools/* resolve from the .npmrc registry again.");
}

if (process.argv.includes("--unlink")) unlink();
else link();
