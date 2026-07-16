import { iterable, predicate } from "@dbx-tools/shared-core";
import { IConstruct } from "constructs";
import { Project } from "projen";
import { DBXToolsProject, DBXToolsNodeProject, DBXToolsTypeScriptProject } from "./project";
import { toPosix } from "./workspace";
import { relative } from "path";
import { match } from "@dbx-tools/shared-file-scan";


/** Guard: the construct is a projen {@link Project} - the base every builder here starts from. */
function isProject(): predicate.Predicate<IConstruct, Project> {
    return predicate.create((c: IConstruct): c is Project => c instanceof Project);
}

function isDBXToolsProject(): predicate.Predicate<IConstruct, DBXToolsProject> {
    return isProject().and(
        (project): project is DBXToolsProject =>
            project instanceof DBXToolsNodeProject || project instanceof DBXToolsTypeScriptProject,
    );
}
/**
 * Matches projects whose npm name matches any glob in `patterns` (e.g. `*\/shared-core`,
 * `@dbx-tools/*`, `shared-*`): each glob is tested against both the full `@scope/name` and the
 * unscoped name.
 */
export function hasName(
    ...patterns: iterable.OneOrMany<string>
): predicate.Predicate<IConstruct, Project> {
    const matchers = iterable.sequence(patterns).map((pattern) => match.toPathMatcher(pattern)).cache();
    return isProject().and((project) => {
        return matchers.some((matcher) => matcher(project.name));
    });
}

/**
 * Matches DBXTools packages carrying every listed tag (`dbxToolsConfig.tags`), narrowing
 * {@link Project} to {@link DBXToolsProject} (tags live only on DBXTools packages). Also the
 * guard backing each built-in {@link WORKSPACE_TAG_MIXINS} entry. Keep it in the SAME `.and(...)`
 * as any name/path filter (or last when chaining) - a later non-tag `.and` re-widens to
 * {@link Project} and drops the narrowing.
 */
export function hasTag(
    ...tags: iterable.OneOrMany<string>
): predicate.Predicate<IConstruct, DBXToolsProject> {
    return isDBXToolsProject().and(project => tags.every((tag) => project.dbxToolsConfig.tags.includes(tag)));
}

/**
 * Matches projects whose folder (relative to the tree root) is at/under any `prefix` - the usual
 * base for scoping mixins to one workspace root (e.g. `predicate.inRelPath("workspaces")`).
 */
export function hasPath(
    ...pathPattern: iterable.OneOrMany<string>
): predicate.Predicate<IConstruct, Project> {
    // Match the path itself AND anything beneath it (`p/**`), so `hasPath("workspaces")`
    // scopes to every package under `workspaces/`, not just one sitting exactly there.
    const matchers = iterable.sequence(pathPattern).map((p) => match.toPathMatcher(p, `${p}/**`)).cache();
    return isProject().and((project) => {
        const relativePath = toPosix(relative(project.root.outdir, project.outdir));
        return matchers.some((matcher) => matcher(relativePath));
    });
}


