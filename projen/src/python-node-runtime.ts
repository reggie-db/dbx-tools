/** Projen task wiring for the shared PythonMonkey Node runtime package. */
import { Component, type Project, type Task } from "projen";
import { runTaskCommand } from "./_task-command.ts";

/** Published Python distribution imported by every generated Node binding loader. */
export const PYTHON_NODE_RUNTIME_DISTRIBUTION = "dbx-tools-node-runtime";

/** Python module that owns the shared PythonMonkey runtime and Node shims. */
export const PYTHON_NODE_RUNTIME_MODULE = "dbx_tools.node_runtime";

/** Repository-wide task that builds the shared Python Node runtime. */
export const PYTHON_NODE_RUNTIME_TASK = "python-node-runtime";

/** Repository-wide task that verifies the shared Python Node runtime. */
export const PYTHON_NODE_RUNTIME_CHECK_TASK = `${PYTHON_NODE_RUNTIME_TASK}:check`;

/** Options for the package that owns the shared PythonMonkey runtime. */
export interface PythonNodeRuntimeOptions {
  /** Repository-relative Python project containing `build-runtime.ts` and `shims/`. */
  readonly projectDirectory: string;
}

/**
 * Registers the shared runtime's build and freshness lifecycle.
 *
 * The runtime package owns the build script, shim sources, generated `runtime.js`,
 * PythonMonkey bootstrap, and bundle loader. This component only connects those
 * package-owned operations to Projen's native synthesis and task lifecycles.
 */
export class PythonNodeRuntime extends Component {
  readonly buildTask: Task;
  readonly checkTask: Task;
  private readonly buildCommand: readonly [string, string];

  constructor(project: Project, options: PythonNodeRuntimeOptions) {
    super(project);
    this.buildCommand = ["bun", `${options.projectDirectory}/build-runtime.ts`];
    this.buildTask = project.addTask(PYTHON_NODE_RUNTIME_TASK, {
      description: "Build the shared PythonMonkey Node runtime",
      execArgs: [...this.buildCommand],
    });
    this.checkTask = project.addTask(PYTHON_NODE_RUNTIME_CHECK_TASK, {
      description: "Verify the shared PythonMonkey Node runtime is current",
      execArgs: [...this.buildCommand, "--check"],
    });
    project.preCompileTask.spawn(this.buildTask);
    project.testTask.spawn(this.checkTask);
  }

  /** Keep the runtime current during one-shot synthesis and native Projen watch. */
  public override postSynthesize(): void {
    const [command, ...args] = this.buildCommand;
    runTaskCommand(this.project.outdir, command, args);
  }
}
