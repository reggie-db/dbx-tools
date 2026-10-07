/** Projen task wiring for the shared PythonMonkey Node runtime package. */
import { Component, type Project, type Task } from "projen";
import { taskCommand } from "./project-js.ts";

/** Published Python distribution imported by every generated Node binding loader. */
export const PYTHON_NODE_RUNTIME_DISTRIBUTION = "dbx-tools-node-runtime";

/** Python module that owns the shared PythonMonkey runtime and Node shims. */
export const PYTHON_NODE_RUNTIME_MODULE = "dbx_tools.node_runtime";

/** Repository-wide task that builds the shared Python Node runtime. */
export const PYTHON_NODE_RUNTIME_TASK = "python-node-runtime";

/** Repository-wide task that verifies the shared Python Node runtime. */
export const PYTHON_NODE_RUNTIME_CHECK_TASK = `${PYTHON_NODE_RUNTIME_TASK}:check`;

/** Repository-wide task that watches the shared Python Node runtime. */
export const PYTHON_NODE_RUNTIME_WATCH_TASK = `${PYTHON_NODE_RUNTIME_TASK}:watch`;

/** Options for the package that owns the shared PythonMonkey runtime. */
export interface PythonNodeRuntimeOptions {
  /** Repository-relative Python project containing `build-runtime.ts` and `shims/`. */
  readonly projectDirectory: string;
}

/**
 * Registers the shared runtime's build, freshness, and watch lifecycle.
 *
 * The runtime package owns the build script, shim sources, generated `runtime.js`,
 * PythonMonkey bootstrap, and bundle loader. This component only connects those
 * package-owned operations to Projen's native task graph.
 */
export class PythonNodeRuntime extends Component {
  readonly buildTask: Task;
  readonly checkTask: Task;
  readonly watchTask: Task;

  constructor(project: Project, options: PythonNodeRuntimeOptions) {
    super(project);
    const buildCommand = ["bun", `${options.projectDirectory}/build-runtime.ts`];
    this.buildTask = project.addTask(PYTHON_NODE_RUNTIME_TASK, {
      description: "Build the shared PythonMonkey Node runtime",
      execArgs: buildCommand,
    });
    this.checkTask = project.addTask(PYTHON_NODE_RUNTIME_CHECK_TASK, {
      description: "Verify the shared PythonMonkey Node runtime is current",
      execArgs: [...buildCommand, "--check"],
    });
    this.watchTask = project.addTask(PYTHON_NODE_RUNTIME_WATCH_TASK, {
      description: "Watch and rebuild the shared PythonMonkey Node runtime",
      execArgs: taskCommand("python-node-runtime-watch.ts", "--project", options.projectDirectory),
    });
    project.preCompileTask.spawn(this.buildTask);
    project.testTask.spawn(this.checkTask);
  }
}
