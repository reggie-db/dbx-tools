/**
 * Renders the projen-owned files for one workspace package. A package is just a
 * folder `packages/<scope>/<name>` (auto-discovered) - all config comes from the
 * scope (see `./scopes`), with `modifyPackage` / `modifyTsconfig` hooks as the
 * only place per-package tweaks (deps, bin, scripts) belong.
 */
import type { Project } from "projen";
import { JsonFile, TextFile } from "projen";
import { type Deps, type ScopeDef, scopeConfig } from "./scopes";

/** A generated manifest/tsconfig: an arbitrary-key record hooks can add to. */
export type PackageManifest = Record<string, unknown>;

/** Where a package lives, plus an optional full-name override. */
export interface PackageSpec {
  readonly scope: string;
  readonly name: string;
  readonly packageName?: string;
}

/** Last-chance hook to change a generated `package.json`. */
export type ModifyPackage = (scope: string, manifest: PackageManifest) => PackageManifest;
/** Last-chance hook to change a generated `tsconfig.json`. */
export type ModifyTsconfig = (scope: string, tsconfig: PackageManifest) => PackageManifest;

export interface DefinePackageOptions {
  readonly scopes?: Record<string, ScopeDef>;
  /** Root npm scope for generated names (see {@link npmNameOf}). */
  readonly rootScope?: string;
  readonly modifyPackage?: ModifyPackage;
  readonly modifyTsconfig?: ModifyTsconfig;
}

/** `packages/<scope>/<name>`. */
export function dirOf(spec: PackageSpec): string {
  return `packages/${spec.scope}/${spec.name}`;
}

/**
 * `packageName` if set, else `@<rootScope>/<scope>-<name>`, collapsing to
 * `@<rootScope>/<name>` when the folder scope IS the root scope. Empty rootScope
 * -> unscoped `<scope>-<name>`.
 */
export function npmNameOf(spec: PackageSpec, rootScope = ""): string {
  if (spec.packageName) return spec.packageName;
  if (!rootScope) return `${spec.scope}-${spec.name}`;
  return spec.scope === rootScope
    ? `@${rootScope}/${spec.name}`
    : `@${rootScope}/${spec.scope}-${spec.name}`;
}

function upToRoot(dir: string): string {
  return "../".repeat(dir.split("/").length);
}

function mergeDeps(...maps: (Deps | undefined)[]): Deps | undefined {
  const merged: Deps = Object.assign({}, ...maps);
  const keys = Object.keys(merged).sort();
  return keys.length ? Object.fromEntries(keys.map((k) => [k, merged[k]!])) : undefined;
}

/** Emit `package.json` + `tsconfig.json` (+ `vite.config.ts`) for a package. */
export function definePackage(
  project: Project,
  spec: PackageSpec,
  options: DefinePackageOptions = {},
): void {
  const dir = dirOf(spec);
  const def = scopeConfig(spec.scope, options.scopes);

  // package.json (baseline from the scope; hook can add/remove anything) --------
  let manifest: PackageManifest = {
    name: npmNameOf(spec, options.rootScope),
    version: "0.0.0",
    private: true,
    type: "module",
    exports: { ".": "./index.ts", "./package.json": "./package.json" },
  };
  const dependencies = mergeDeps(def.dependencies);
  const devDependencies = mergeDeps(def.devDependencies);
  const peerDependencies = mergeDeps(def.peerDependencies);
  if (dependencies) manifest.dependencies = dependencies;
  if (devDependencies) manifest.devDependencies = devDependencies;
  if (peerDependencies) manifest.peerDependencies = peerDependencies;
  if (def.scripts) manifest.scripts = { ...def.scripts };
  if (options.modifyPackage) manifest = options.modifyPackage(spec.scope, manifest);

  new JsonFile(project, `${dir}/package.json`, { marker: true, readonly: true, obj: manifest });

  // tsconfig.json (the scope enforcement lives here) ---------------------------
  let tsconfig: PackageManifest = {
    extends: `${upToRoot(dir)}tsconfig.base.json`,
    compilerOptions: { ...def.compilerOptions },
    include: ["index.ts", "src", "test"],
  };
  if (options.modifyTsconfig) tsconfig = options.modifyTsconfig(spec.scope, tsconfig);

  new JsonFile(project, `${dir}/tsconfig.json`, { marker: true, readonly: true, obj: tsconfig });

  // vite.config.ts for scopes that build with Vite -----------------------------
  if (def.viteConfig) {
    new TextFile(project, `${dir}/vite.config.ts`, {
      marker: true,
      readonly: true,
      lines: [
        'import react from "@vitejs/plugin-react";',
        'import { defineConfig } from "vite";',
        "",
        "export default defineConfig({ plugins: [react()] });",
        "",
      ],
    });
  }
}
