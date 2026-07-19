#!/usr/bin/env node
/**
 * Toggle the demo's CLIENT app between its two dependency-resolution modes for
 * the `@dbx-tools/*` packages:
 *
 *   - DEFAULT (consumer): packages install from the registry in `.npmrc`
 *     (a local verdaccio), as any downstream app would. Source changes in the
 *     main repo only appear after bump -> publish -> `pnpm update`.
 *   - DEV-LINK (this script): the client-reachable workspace packages are added
 *     as members of the demo's pnpm workspace and the client app's
 *     `@dbx-tools/*` deps are switched to `workspace:*`. The running `vite` dev
 *     server (which dedupes React via `vite.config.override.js`) then
 *     hot-reloads main-repo UI edits with no republish or rebuild.
 *
 * CLIENT ONLY, deliberately. Linking the SERVER packages fails: their
 * transitive `@databricks/appkit` / `@mastra/*` resolve to a SECOND physical
 * install (same version, different peer-hash) than the demo's, so singletons
 * like AppKit's `CacheManager` initialize in one copy and are read from the
 * other ("CacheManager not initialized"). The browser build avoids this via
 * vite's `dedupe`, which has no server-side (tsx) equivalent. So the server
 * keeps the publish cycle; only the UI packages are source-linked.
 *
 * Usage:
 *   node demo/scripts/dev-link.mjs            # link client UI source
 *   node demo/scripts/dev-link.mjs --unlink   # restore the registry consumer
 *
 * All edits are marked so `--unlink` reverses exactly what was added. This is
 * transient LOCAL dev state - run `--unlink` (or discard the changes) before
 * committing; the committed demo always stays a clean registry consumer.
 *
 * Discovery is dynamic: the linked set is the closure of the client app's
 * `@dbx-tools/*` deps followed through each package's own `@dbx-tools/*` deps,
 * so packages added / removed / renamed need no edit here.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const demoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = path.resolve(demoRoot, "..");
const workspacesRoot = path.join(repoRoot, "workspaces");
const workspaceYaml = path.join(demoRoot, "pnpm-workspace.yaml");
// The demo member whose deps we link: the CLIENT app only (see the server note).
const clientManifest = path.join(demoRoot, "app/appkit-demo/package.json");

const read = (p) => fs.readFileSync(p, "utf8");
const readJson = (p) => JSON.parse(read(p));

// npm scope discovered from the demo's own package name (`@dbx-tools/demo` ->
// `@dbx-tools/`) so a project-wide rename needs no edit here.
const scope = `${readJson(path.join(demoRoot, "package.json")).name.split("/")[0]}/`;

const MARK = "# dbx-tools:dev-link";
// Sidecar recording the pristine workspace file + each dep's pre-link
// specifier, so `--unlink` restores both exactly. Only file left behind;
// already gitignored.
const stateFile = path.join(demoRoot, ".dev-link.json");

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"];

/** Map every workspace package NAME under this scope to its source directory. */
function workspacePackages() {
  const out = {};
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === "lib" || ent.name === ".git") continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name === "package.json") {
        const name = readJson(p).name;
        if (typeof name === "string" && name.startsWith(scope)) out[name] = path.dirname(p);
      }
    }
  };
  walk(workspacesRoot);
  return out;
}

/** The `@dbx-tools/*` deps a package declares (any field). */
function scopedDeps(manifestPath) {
  const m = readJson(manifestPath);
  const names = new Set();
  for (const field of DEP_FIELDS) {
    for (const name of Object.keys(m[field] ?? {})) {
      if (name.startsWith(scope)) names.add(name);
    }
  }
  return names;
}

/**
 * Closure of workspace packages reachable from the client app's `@dbx-tools/*`
 * deps, followed transitively through each package's own `@dbx-tools/*` deps.
 * This is exactly the source the browser bundle pulls - and no more - so the
 * server-only packages (which would double-install singletons) stay excluded.
 */
function clientReachable(pkgDirs) {
  const reachable = new Set();
  const queue = [...scopedDeps(clientManifest)];
  while (queue.length) {
    const name = queue.shift();
    if (reachable.has(name) || !pkgDirs[name]) continue;
    reachable.add(name);
    for (const dep of scopedDeps(path.join(pkgDirs[name], "package.json"))) {
      if (!reachable.has(dep)) queue.push(dep);
    }
  }
  return reachable;
}

function pnpmInstall() {
  execFileSync("pnpm", ["install", "--no-frozen-lockfile"], { cwd: demoRoot, stdio: "inherit" });
}

/** Simple flat `catalog:` block reader (one `  key: value` per line). */
function parseCatalog(yaml) {
  const out = {};
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === "catalog:");
  if (start === -1) return out;
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line) || line.trim() === "") break;
    const m = line.match(/^\s+("?[^":]+"?):\s*(.+?)\s*$/);
    if (m) out[m[1].replace(/"/g, "")] = m[2];
  }
  return out;
}

function link() {
  const pkgDirs = workspacePackages();
  const reachable = clientReachable(pkgDirs);
  if (reachable.size === 0) {
    console.log("dev-link: no client @dbx-tools deps found - nothing to link.");
    return;
  }

  // 1. Add the reachable packages as explicit workspace members (not a broad
  //    glob, so server-only packages stay out), and merge any main-repo
  //    catalog entries they reference so their `catalog:` deps resolve.
  let yaml = read(workspaceYaml);
  const pristineYaml = yaml;
  if (!yaml.includes(MARK)) {
    const memberLines = [...reachable]
      .map((name) => `  - "${path.relative(demoRoot, pkgDirs[name])}" ${MARK}`)
      .join("\n");
    yaml = yaml.replace(/^packages:\n/m, `packages:\n${memberLines}\n`);
    const demoCatalog = parseCatalog(yaml);
    const repoCatalog = parseCatalog(read(path.join(repoRoot, "pnpm-workspace.yaml")));
    const additions = Object.entries(repoCatalog).filter(([k]) => !(k in demoCatalog));
    if (additions.length > 0) {
      const block = additions
        .map(([k, v]) => `  ${/^[a-z0-9_.-]+$/i.test(k) ? k : `"${k}"`}: ${v} ${MARK}`)
        .join("\n");
      yaml = yaml.replace(/^catalog:\n/m, `catalog:\n${block}\n`);
    }
    fs.writeFileSync(workspaceYaml, yaml);
  }

  // 2. Switch the CLIENT app's reachable @dbx-tools deps to workspace:*,
  //    recording prior specifiers so `--unlink` restores them exactly.
  const prior = {};
  const manifest = readJson(clientManifest);
  for (const field of DEP_FIELDS) {
    const deps = manifest[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (reachable.has(name) && !deps[name].startsWith("workspace:")) {
        prior[`${field}\t${name}`] = deps[name];
        deps[name] = "workspace:*";
      }
    }
  }
  fs.writeFileSync(clientManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(stateFile, `${JSON.stringify({ workspaceYaml: pristineYaml, deps: prior }, null, 2)}\n`);

  console.log(
    `dev-link: linked ${reachable.size} client UI packages to workspace source. Installing...`,
  );
  pnpmInstall();
  console.log(
    "dev-link: done. Run `pnpm --filter @dbx-tools/demo-appkit-app dev`; edits under the linked workspaces/**/src hot-reload in the browser. (The server keeps the publish cycle.)",
  );
}

function unlink() {
  const state = fs.existsSync(stateFile) ? readJson(stateFile) : {};
  if (typeof state.workspaceYaml === "string") {
    fs.writeFileSync(workspaceYaml, state.workspaceYaml);
  } else {
    fs.writeFileSync(
      workspaceYaml,
      read(workspaceYaml)
        .split("\n")
        .filter((line) => !line.includes(MARK))
        .join("\n"),
    );
  }
  const prior = state.deps ?? {};
  const manifest = readJson(clientManifest);
  for (const field of DEP_FIELDS) {
    const deps = manifest[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith(scope) && deps[name].startsWith("workspace:")) {
        deps[name] = prior[`${field}\t${name}`] ?? "*";
      }
    }
  }
  fs.writeFileSync(clientManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(stateFile, { force: true });
  console.log("dev-link: removed workspace members + restored deps. Reinstalling...");
  pnpmInstall();
  console.log("dev-link: done. @dbx-tools/* resolve from the .npmrc registry again.");
}

if (process.argv.includes("--unlink")) unlink();
else link();
