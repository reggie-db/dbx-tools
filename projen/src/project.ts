/**
 * Language-agnostic project selection helpers and the compatibility facade for
 * dbx-tools project implementations.
 */
import { type PathMatchInput } from "@dbx-tools/path";
import { object, type OneOrMany } from "@dbx-tools/shared-core";
import { type IConstruct } from "constructs";
import { Project, type ProjectOptions } from "projen";
import * as mixin from "./mixin.ts";
import * as projectPredicate from "./project-predicate.ts";
import type { DBXToolsJavaScriptProject } from "./project-js.ts";

export * from "./project-js.ts";
export * from "./project-py.ts";

/** Runtime family implemented by a dbx-tools project. */
export type DBXToolsProjectLanguage = "javascript" | "python";

/** Options shared by every dbx-tools project implementation. */
export interface DBXToolsProjectOptions extends Partial<
  Pick<ProjectOptions, "name" | "parent" | "outdir">
> {}

/** Minimal language-agnostic project contract. */
export interface DBXToolsProject extends Project {
  readonly language: DBXToolsProjectLanguage;
}

/** Filters selecting which projects an {@link applyToProjects} call runs against. */
export interface ApplyToProjectsOptions {
  /** Include plain projen projects. Defaults to DBXTools projects only. */
  includeNonDBXToolsProjects?: boolean;
  /** Include tree roots. Defaults to child projects only. */
  includeRoots?: boolean;
  /** Match the raw projen project name. */
  name?: PathMatchInput | OneOrMany<PathMatchInput>;
  /** Match the parsed full package name. */
  identifierPackageName?: PathMatchInput | OneOrMany<PathMatchInput>;
  /** Match the parsed package scope. */
  identifierScope?: PathMatchInput | OneOrMany<PathMatchInput>;
  /** Match the parsed unscoped package name. */
  identifierName?: PathMatchInput | OneOrMany<PathMatchInput>;
  /** Match every listed dbx-tools tag. */
  tags?: PathMatchInput | OneOrMany<PathMatchInput>;
  /** Match the path relative to the tree root. */
  path?: PathMatchInput | OneOrMany<PathMatchInput>;
}

type ApplyToDBXToolsProjectsOptions = Omit<ApplyToProjectsOptions, "includeNonDBXToolsProjects"> & {
  includeNonDBXToolsProjects?: false;
};

type ApplyToAllProjectsOptions = Omit<ApplyToProjectsOptions, "includeNonDBXToolsProjects"> & {
  includeNonDBXToolsProjects: true;
};

/** Apply callbacks to projects matching all supplied filters. */
export function applyToProjects(
  construct: IConstruct,
  ...args:
    | [ApplyToDBXToolsProjectsOptions, ...OneOrMany<(project: DBXToolsJavaScriptProject) => void>]
    | OneOrMany<(project: DBXToolsJavaScriptProject) => void>
): void;

export function applyToProjects(
  construct: IConstruct,
  ...args: [ApplyToAllProjectsOptions, ...OneOrMany<(project: Project) => void>]
): void;

export function applyToProjects<P extends Project>(
  construct: IConstruct,
  ...args:
    [ApplyToProjectsOptions, ...OneOrMany<(project: P) => void>] | OneOrMany<(project: P) => void>
): void;

export function applyToProjects<P extends Project>(
  construct: IConstruct,
  ...args:
    [ApplyToProjectsOptions, ...OneOrMany<(project: P) => void>] | OneOrMany<(project: P) => void>
): void {
  const [first, ...rest] = args;
  const hasOptions = typeof first !== "function";
  const options = hasOptions ? (first as ApplyToProjectsOptions) : undefined;
  const callbacks = (hasOptions ? rest : args) as OneOrMany<(project: Project) => void>;
  let predicate = projectPredicate.isProject();
  if (!options?.includeNonDBXToolsProjects) {
    predicate = predicate.and(projectPredicate.isDBXToolsJavaScriptProject());
  }
  if (!options?.includeRoots) predicate = predicate.and((project) => project.parent != null);
  if (options?.identifierPackageName) {
    predicate = predicate.and(
      projectPredicate.hasIdentifierPackageName(
        ...object.toOneOrMany(options.identifierPackageName),
      ),
    );
  }
  if (options?.name) {
    predicate = predicate.and(projectPredicate.hasName(...object.toOneOrMany(options.name)));
  }
  if (options?.identifierScope) {
    predicate = predicate.and(
      projectPredicate.hasIdentifierScope(...object.toOneOrMany(options.identifierScope)),
    );
  }
  if (options?.identifierName) {
    predicate = predicate.and(
      projectPredicate.hasIdentifierName(...object.toOneOrMany(options.identifierName)),
    );
  }
  if (options?.tags) {
    predicate = predicate.and(projectPredicate.hasTag(...object.toOneOrMany(options.tags)));
  }
  if (options?.path) {
    predicate = predicate.and(projectPredicate.hasPath(...object.toOneOrMany(options.path)));
  }
  const projectMixin = mixin.create(predicate, (project) => {
    callbacks.forEach((callback) => callback(project as Project));
  });
  construct.with(projectMixin);
}
