import { object, predicate, Sequence, type OneOrMany, type Predicate } from "@dbx-tools/shared-core";
import { IConstruct } from "constructs";
import { Project } from "projen";
import { DBXToolsProject, DBXToolsNodeProject, DBXToolsTypeScriptProject } from "./project";
import { toPosix } from "./workspace";
import { relative } from "path";
import { match, PathMatchInput, PathMatchPredicate } from "@dbx-tools/path";
import { project } from "..";

/** Guard: the construct is a projen {@link Project} - the base every builder here starts from. */
export function isProject(): Predicate<IConstruct, Project> {
  return predicate.create((c: IConstruct): c is Project => c instanceof Project);
}

/** Guard: the construct is a {@link DBXToolsProject} (a DBXTools Node or TypeScript project). */
export function isDBXToolsProject(): Predicate<IConstruct, DBXToolsProject> {
  return isProject().and(
    (project): project is DBXToolsProject =>
      project instanceof DBXToolsNodeProject || project instanceof DBXToolsTypeScriptProject,
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
export function hasIdentifierPackageName(...patterns: OneOrMany<PathMatchInput>): Predicate<IConstruct, Project> {
  const matchers = projectMatchers(...patterns);
  return isProject().and((p) => {
    const packageName = project.identifier(p).packageName;
    return matchers.every((matcher) => matcher(packageName));
  });
}

/** Matches projects whose parsed unscoped name (from {@link PackageIdentifier}) matches every glob. */
export function hasIdentifierName(...patterns: OneOrMany<PathMatchInput>): Predicate<IConstruct, Project> {
  const matchers = projectMatchers(...patterns);
  return isProject().and((p) => {
    const name = project.identifier(p).name;
    return matchers.every((matcher) => matcher(name));
  });
}

/** Matches projects whose parsed npm scope (from {@link PackageIdentifier}) matches every glob. */
export function hasIdentifierScope(...patterns: OneOrMany<PathMatchInput>): Predicate<IConstruct, Project> {
  const matchers = projectMatchers(...patterns);
  return isProject().and((p) => {
    const scope = project.identifier(p).scope;
    return scope && matchers.every((matcher) => matcher(scope));
  });
}



/**
 * Matches DBXTools packages carrying every listed tag (`dbxToolsConfig.tags`), narrowing
 * {@link Project} to {@link DBXToolsProject} (tags live only on DBXTools packages). Also the
 * guard backing each built-in {@link WORKSPACE_TAG_MIXINS} entry. Keep it in the SAME `.and(...)`
 * as any name/path filter (or last when chaining) - a later non-tag `.and` re-widens to
 * {@link Project} and drops the narrowing.
 */
export function hasTag(...tags: OneOrMany<PathMatchInput>): Predicate<IConstruct, DBXToolsProject> {
  const matchers = projectMatchers(...tags);
  return isDBXToolsProject().and((project) =>
    matchers.every((matcher) => project.dbxToolsConfig.tags.some((tag) => matcher(tag))),
  );
}

/**
 * Matches projects whose folder (relative to the tree root) matches any glob in
 * `pathPattern`. Globs are matched verbatim, so scope to a subtree with an
 * explicit pattern - e.g. `hasPath("workspaces/**")` for every package under
 * `workspaces/`.
 */
export function hasPath(...pathPattern: OneOrMany<PathMatchInput>): Predicate<IConstruct, Project> {
  const matchers = projectMatchers(...pathPattern);
  return isProject().and((project) => {
    const relativePath = toPosix(relative(project.root.outdir, project.outdir));
    return matchers.some((matcher) => matcher(relativePath));
  });
}
