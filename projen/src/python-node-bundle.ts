import { Component, type Project, type Task } from "projen";
import { isDBXToolsJavaScriptProject } from "./project-predicate.ts";

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
  /** Repository-relative directory containing Node built-in shims. */
  readonly shimRoot?: string;
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
  /** Regenerate during the root workspace watch loop. Defaults to false. */
  readonly watch?: boolean;
}

/** Owns paired generation and freshness-check tasks for one Python package. */
export class PythonNodeBundle extends Component {
  readonly buildTask: Task;
  readonly checkTask: Task;
  readonly watchTask?: Task;

  constructor(project: Project, options: PythonNodeBundleOptions) {
    super(project);
    const command = [
      "bun",
      "projen/tasks/python-node-bindings.ts",
      "--project",
      shellQuote(options.projectDirectory),
    ].join(" ");
    this.buildTask = project.addTask(`${options.name}:python-runtime`, {
      description: `Generate Node bindings for Python package ${options.name}`,
      exec: command,
    });
    this.checkTask = project.addTask(`${options.name}:python-runtime:check`, {
      description: `Verify generated Node bindings for Python package ${options.name}`,
      exec: `${command} --check`,
    });
    if (options.test ?? true) project.testTask.spawn(this.checkTask);
    if (options.watch) {
      this.watchTask = project.addTask(`${options.name}:python-runtime:watch`, {
        description: `Regenerate Node bindings for Python package ${options.name} on changes`,
        exec: [
          "bun",
          "projen/tasks/python-node-bindings-watch.ts",
          "--project",
          shellQuote(options.projectDirectory),
        ].join(" "),
      });
      if (isDBXToolsJavaScriptProject()(project)) {
        const configured = project.dbxToolsConfig.pythonNodeBindings;
        const projects = Array.isArray(configured)
          ? configured.filter((value): value is string => typeof value === "string")
          : [];
        project.dbxToolsConfig.pythonNodeBindings = [
          ...new Set([...projects, options.projectDirectory]),
        ];
      }
    }
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=+#-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
