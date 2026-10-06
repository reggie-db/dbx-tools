/**
 * Composable, runtime-safe predicates for selecting Projen projects by type,
 * package identity, tags, and repository path.
 */
import { relative } from "node:path";
import { match, PathMatchInput, PathMatchPredicate } from "@dbx-tools/path";
import {
  object,
  predicate,
  Sequence,
  type OneOrMany,
  type Predicate,
} from "@dbx-tools/shared-core";
import { IConstruct } from "constructs";
import { Project } from "projen";
import { toPosix } from "./packages.ts";
import { identifier, type DBXToolsJavaScriptProject } from "./project-js.ts";
import type { DBXToolsProject } from "./project.ts";

/**
 * Guard: the construct is a projen {@link Project} - the base every builder here
 * starts from.
 *
 * Uses projen's own `Project.isProject` rather than `instanceof`. It tests for
 * `Symbol.for("projen.Project")`, which every `Project` constructor stamps on
 * itself, so it still matches if an invalid consumer install resolves a second
 * Projen copy despite the engine's peer dependency. An `instanceof` guard would
 * silently reject that construct before the install problem can be diagnosed.
 */
export function isProject(): Predicate<IConstruct, Project> {
  return predicate.create((c: IConstruct): c is Project => Project.isProject(c));
}

/** Guard: the construct implements the language-agnostic {@link DBXToolsProject} contract. */
export function isDBXToolsProject(): Predicate<IConstruct, DBXToolsProject> {
  return isProject().and(
    (project): project is DBXToolsProject =>
      (project as Partial<DBXToolsProject>).language === "javascript" ||
      (project as Partial<DBXToolsProject>).language === "python",
  );
}

/** Guard: the construct is a dbx-tools JavaScript/TypeScript project. */
export function isDBXToolsJavaScriptProject(): Predicate<IConstruct, DBXToolsJavaScriptProject> {
  return isDBXToolsProject().and(
    (project): project is DBXToolsJavaScriptProject => project.language === "javascript",
  );
}

/**
 * Compile each glob/predicate input to a {@link PathMatchPredicate} once, cached
 * so the returned {@link Sequence} is re-iterable across every project tested by
 * the resulting predicate.
 */
function projectMatchers(...inputs: OneOrMany<PathMatchInput>): Sequence<PathMatchPredicate> {
  return object
    .sequence(inputs)
    .map((input) => match.toPathMatcher(input))
    .cache();
}

/**
 * Matches projects whose raw projen {@link Project.name} matches every glob in
 * `patterns` (e.g. `@dbx-tools/ui-mastra`, `*-mastra`). Tests `project.name`
 * verbatim, without normalizing through {@link PackageIdentifier} - use the
 * `hasIdentifier*` variants to match the parsed scope/name instead.
 */
export function hasName(...patterns: OneOrMany<PathMatchInput>): Predicate<IConstruct, Project> {
  const matchers = projectMatchers(...patterns);
  return isProject().and((p) => matchers.every((matcher) => matcher(p.name)));
}

/**
 * Matches projects whose parsed npm name matches every glob in `patterns` (e.g.
 * `*\/shared-core`, `@dbx-tools/*`): tested against the full `@scope/name` from
 * {@link PackageIdentifier}.
 */
export function hasIdentifierPackageName(
  ...patterns: OneOrMany<PathMatchInput>
): Predicate<IConstruct, Project> {
  const matchers = projectMatchers(...patterns);
  return isProject().and((p) => {
    const packageName = identifier(p).packageName;
    return matchers.every((matcher) => matcher(packageName));
  });
}

/** Matches projects whose parsed unscoped name (from {@link PackageIdentifier}) matches every glob. */
export function hasIdentifierName(
  ...patterns: OneOrMany<PathMatchInput>
): Predicate<IConstruct, Project> {
  const matchers = projectMatchers(...patterns);
  return isProject().and((p) => {
    const name = identifier(p).name;
    return matchers.every((matcher) => matcher(name));
  });
}

/** Matches projects whose parsed npm scope (from {@link PackageIdentifier}) matches every glob. */
export function hasIdentifierScope(
  ...patterns: OneOrMany<PathMatchInput>
): Predicate<IConstruct, Project> {
  const matchers = projectMatchers(...patterns);
  return isProject().and((p) => {
    const scope = identifier(p).scope;
    return scope && matchers.every((matcher) => matcher(scope));
  });
}

/**
 * Matches DBXTools packages carrying every listed tag (`dbxToolsConfig.tags`), narrowing
 * {@link Project} to {@link DBXToolsJavaScriptProject} (tags live only on JavaScript packages). Also the
 * guard backing each built-in {@link PACKAGE_TAG_MIXINS} entry. Keep it in the SAME `.and(...)`
 * as any name/path filter (or last when chaining) - a later non-tag `.and` re-widens to
 * {@link Project} and drops the narrowing.
 */
export function hasTag(
  ...tags: OneOrMany<PathMatchInput>
): Predicate<IConstruct, DBXToolsJavaScriptProject> {
  const matchers = projectMatchers(...tags);
  return isDBXToolsJavaScriptProject().and((project) =>
    matchers.every((matcher) => project.dbxToolsConfig.tags.some((tag) => matcher(tag))),
  );
}

/**
 * Matches projects whose folder (relative to the tree root) matches any glob in
 * `pathPattern`. Globs are matched verbatim, so scope to a subtree with an
 * explicit pattern - e.g. `hasPath("packages/**")` for every package under
 * `packages/`.
 */
export function hasPath(...pathPattern: OneOrMany<PathMatchInput>): Predicate<IConstruct, Project> {
  const matchers = projectMatchers(...pathPattern);
  return isProject().and((project) => {
    const relativePath = toPosix(relative(project.root.outdir, project.outdir));
    return matchers.some((matcher) => matcher(relativePath));
  });
}
