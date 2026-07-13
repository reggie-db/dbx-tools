/**
 * Mixin-based configuration (`constructs` `IMixin` + subtree traversal).
 *
 * A mixin is `{ supports(c), applyTo(c) }`. Apply them with the constructs-native
 * `construct.with(...mixins)`, which runs each across the construct's whole subtree
 * (the tree is captured at call time). The root applies the built-in
 * {@link DEFAULT_TAG_MIXINS} during construction; callers apply their own with
 * `project.with(...)` afterward, so defaults run before user mixins.
 *
 * These replace the removed callback options (`workspacePackage`,
 * `onGeneratedFile`) and the `DEFAULT_WORKSPACE_PACKAGE_MODIFIERS` registry:
 *   - {@link tagMixin} / {@link packageMixin} target a {@link DBXToolsTypeScriptProject};
 *   - {@link fileMixin} targets any generated `FileBase`;
 *   - {@link DEFAULT_TAG_MIXINS} ports the per-tag defaults (e.g. `server`).
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

/**
 * Built-in per-tag mixins, toggled by the `defaultTagMixins` option (`"all"` by
 * default). Ports the old `DEFAULT_WORKSPACE_PACKAGE_MODIFIERS`; extend this
 * registry to add more. Applied before user mixins.
 */
export const DEFAULT_TAG_MIXINS = {
  /** A `server` package: an Express app run/watched with tsx (AppKit-aligned). */
  server: tagMixin("server", (pkg) => {
    pkg.addDeps("express@catalog:");
    pkg.addDevDeps("@types/express@catalog:");
    pkg.addTask("dev", { exec: "tsx watch src/server.ts" });
    pkg.addTask("start", { exec: "tsx src/server.ts" });
  }),
} satisfies Record<string, IMixin>;

/** A selectable default tag mixin - a key of {@link DEFAULT_TAG_MIXINS}. */
export type DefaultTagMixinName = keyof typeof DEFAULT_TAG_MIXINS;


