/** Projen task wiring for repository-wide PythonMonkey Node binding generation. */
import { Component, type Project, type Task } from "projen";
import { taskCommand } from "./project-js.ts";

/** Repository-wide task that regenerates every configured Python Node bridge. */
export const PYTHON_NODE_BINDINGS_TASK = "python-node-bindings";

/** Repository-wide task that verifies every generated Python Node bridge. */
export const PYTHON_NODE_BINDINGS_CHECK_TASK = `${PYTHON_NODE_BINDINGS_TASK}:check`;

/** Repository-wide task that watches every configured Python Node bridge. */
export const PYTHON_NODE_BINDINGS_WATCH_TASK = `${PYTHON_NODE_BINDINGS_TASK}:watch`;

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

/** Options for repository-wide PythonMonkey Node binding tasks. */
export interface PythonNodeBindingsComponentOptions {
  /** Add the repository-wide freshness check to the test task. Defaults to true. */
  readonly test?: boolean;
}

/**
 * Registers one build, freshness, and watch lifecycle for every configured
 * `[tool.dbx_tools.node_bindings]` table in the repository.
 */
export class PythonNodeBindings extends Component {
  readonly buildTask: Task;
  readonly checkTask: Task;
  readonly watchTask: Task;

  constructor(project: Project, options: PythonNodeBindingsComponentOptions = {}) {
    super(project);
    const command = taskCommand("python-node-bindings.ts");
    this.buildTask = project.addTask(PYTHON_NODE_BINDINGS_TASK, {
      description: "Generate every configured Python Node binding",
      execArgs: command,
    });
    this.checkTask = project.addTask(PYTHON_NODE_BINDINGS_CHECK_TASK, {
      description: "Verify every configured Python Node binding is current",
      execArgs: [...command, "--check"],
    });
    this.watchTask = project.addTask(PYTHON_NODE_BINDINGS_WATCH_TASK, {
      description: "Watch and regenerate affected Python Node bindings",
      execArgs: taskCommand("python-node-bindings-watch.ts"),
    });
    project.preCompileTask.spawn(this.buildTask);
    if (options.test ?? true) project.testTask.spawn(this.checkTask);
  }
}
