/**
 * Mixin-based configuration (`constructs` `IMixin` + subtree traversal).
 *
 * A mixin is `{ supports(c), applyTo(c) }`. Apply them with the constructs-native
 * `construct.with(...mixins)`, which runs each across the construct's whole subtree
 * (the tree is captured at call time). The root applies the built-in tag mixins
 * (`WORKSPACE_TAG_MIXINS` in `./tags`) during construction; callers apply their own
 * with `project.with(...)` afterward, so defaults run before user mixins.
 *
 * This module is the mixin FACTORIES only - the per-tag table itself lives in
 * `./tags`:
 *   - {@link tagMixin} / {@link packageMixin} target a {@link DBXToolsTypeScriptProject};
 *   - {@link fileMixin} targets any generated `FileBase`.
 */
import type { IConstruct, IMixin } from "constructs";
import { FileBase, typescript } from "projen";
// Type-only import: pulling the class VALUE in at module top level drags
// project.ts -> tags.ts (which calls `tagMixin` at eval time) into this module's
// init, before esbuild's keepNames `__name` helper is assigned - crashing under
// tsx. Detect the class structurally instead (see `isDBXToolsPackage`).
import type { DBXToolsTypeScriptProject } from "./project";

/** Structural guard for a {@link DBXToolsTypeScriptProject} (no runtime import cycle). */
function isDBXToolsPackage(c: IConstruct): c is DBXToolsTypeScriptProject {
  return c instanceof typescript.TypeScriptProject && "dbxToolsConfig" in c;
}

/** A mixin that runs `apply` on every workspace package carrying `tag`. */
export function tagMixin(
  tag: string,
  apply: (pkg: DBXToolsTypeScriptProject) => void,
): IMixin {
  return {
    supports: (c: IConstruct): boolean =>
      isDBXToolsPackage(c) && c.dbxToolsConfig.tags.includes(tag),
    applyTo: (c: IConstruct): void => apply(c as DBXToolsTypeScriptProject),
  };
}

/**
 * A mixin that runs `apply` on every workspace package matching `predicate` -
 * for dispatching on a package's resolved tags AND its folder name (e.g.
 * `p.dbxToolsConfig.tags.includes("cli") && basename(p.outdir) === "main"`), the
 * way the old `workspacePackage(pkg)` hook did.
 */
export function packageMixin(
  predicate: (pkg: DBXToolsTypeScriptProject) => boolean,
  apply: (pkg: DBXToolsTypeScriptProject) => void,
): IMixin {
  return {
    supports: (c: IConstruct): boolean => isDBXToolsPackage(c) && predicate(c),
    applyTo: (c: IConstruct): void => apply(c as DBXToolsTypeScriptProject),
  };
}

/** A mixin that runs `apply` on every generated projen file. */
export function fileMixin(apply: (file: FileBase) => void): IMixin {
  return {
    supports: (c: IConstruct): boolean => c instanceof FileBase,
    applyTo: (c: IConstruct): void => apply(c as FileBase),
  };
}
