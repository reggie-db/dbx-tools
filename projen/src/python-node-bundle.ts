import { Component, type Project, type Task } from "projen";

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

/** Options for a generated JavaScript runtime consumed through PythonMonkey. */
export interface PythonNodeBundleOptions {
  /** Stable task-name prefix, such as `auth`. */
  readonly name: string;
  /** Repository-relative Node/TypeScript entrypoint. */
  readonly entry: string;
  /** Repository-relative generated bundle destination. */
  readonly output: string;
  /** Human-readable generated-source description. */
  readonly source: string;
  /** Repository-relative directory containing Node built-in shims. */
  readonly shimRoot?: string;
  /** Functions replaced only while generating this bundle. */
  readonly functionOverrides?: readonly PythonNodeFunctionOverride[];
  /** Add the freshness check to the project's test task. Defaults to true. */
  readonly test?: boolean;
}

/** Owns paired generation and freshness-check tasks for a PythonMonkey runtime. */
export class PythonNodeBundle extends Component {
  readonly buildTask: Task;
  readonly checkTask: Task;

  constructor(project: Project, options: PythonNodeBundleOptions) {
    super(project);
    const command = bundleCommand(options);
    this.buildTask = project.addTask(`${options.name}:python-runtime`, {
      description: `Bundle ${options.source}`,
      exec: command,
    });
    this.checkTask = project.addTask(`${options.name}:python-runtime:check`, {
      description: `Verify the committed ${options.source} runtime is current`,
      exec: `${command} --check`,
    });
    if (options.test ?? true) project.testTask.spawn(this.checkTask);
  }
}

function bundleCommand(options: PythonNodeBundleOptions): string {
  const args = [
    "bun",
    "projen/tasks/python-node-bindings.ts",
    "--entry",
    options.entry,
    "--output",
    options.output,
    ...(options.shimRoot ? ["--shim-root", options.shimRoot] : []),
    "--source",
    options.source,
    ...(options.functionOverrides ?? []).flatMap((override) => [
      "--function-override",
      `${override.module}#${override.export}=${override.handler}#${override.handlerExport ?? override.export}`,
    ]),
  ];
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=+#-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
