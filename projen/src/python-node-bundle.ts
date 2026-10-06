/**
 * Projen task wiring for pyproject-driven PythonMonkey runtime generation.
 *
 * Type extraction and bundle emission remain in the executable generator; this
 * component owns only typed configuration and generate/check task registration.
 */
import { Component, type Project, type Task } from "projen";
import { taskCommand } from "./project-js.ts";

/** One function replaced only in a generated PythonMonkey bundle. */
export interface PythonNodeFunctionOverride {
  /** Module specifier imported by the ordinary Node source. */
  readonly module: string;
  /** Named export to replace. */
  readonly export: string;
  /** Repository-relative TypeScript file containing the replacement. */
  readonly handler: string;
  /** Named export in {@link handler}. Defaults to {@link export}. */
  readonly handlerExport?: string;
}

/** Node package embedded into one Python distribution through PythonMonkey. */
export interface PythonNodeBindingsOptions {
  /** Public Node package specifier, such as `@dbx-tools/auth`. */
  readonly package: string;
  /** Optional portable package subpath to bind. Defaults to {@link package}. */
  readonly entrypoint?: string;
  /** Automatically generated root namespace modules to bind independently. */
  readonly modules?: readonly string[];
  /** Functions replaced only while generating the Python runtime. */
  readonly functionOverrides?: readonly PythonNodeFunctionOverride[];
}

/** Options for pyproject-driven PythonMonkey generation tasks. */
export interface PythonNodeBundleOptions {
  /** Stable task-name prefix, such as `auth`. */
  readonly name: string;
  /** Repository-relative Python project containing `pyproject.toml`. */
  readonly projectDirectory: string;
  /** Add the freshness check to the project's test task. Defaults to true. */
  readonly test?: boolean;
}

/** Owns paired generation and freshness-check tasks for one Python package. */
export class PythonNodeBundle extends Component {
  readonly buildTask: Task;
  readonly checkTask: Task;

  constructor(project: Project, options: PythonNodeBundleOptions) {
    super(project);
    const command = taskCommand("python-node-bindings.ts", "--project", options.projectDirectory);
    this.buildTask = project.addTask(`${options.name}:python-runtime`, {
      description: `Generate Node bindings for Python package ${options.name}`,
      execArgs: command,
    });
    this.checkTask = project.addTask(`${options.name}:python-runtime:check`, {
      description: `Verify generated Node bindings for Python package ${options.name}`,
      execArgs: [...command, "--check"],
    });
    if (options.test ?? true) project.testTask.spawn(this.checkTask);
  }
}
