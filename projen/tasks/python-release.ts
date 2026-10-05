/** Shared Python release manifest parsing and dependency projection. */

const projectTable = (document: unknown): Record<string, unknown> => {
  const project = (document as { project?: unknown })?.project;
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw new Error("Missing Python project metadata");
  }
  return project as Record<string, unknown>;
};

const directSibling = (
  dependency: string,
  sibling: { readonly directory: string; readonly name: string },
): boolean => {
  const prefix = `${sibling.name} @ git+`;
  if (!dependency.startsWith(prefix)) return false;
  const marker = "#subdirectory=";
  const markerIndex = dependency.indexOf(marker, prefix.length);
  if (markerIndex < 0) return false;
  const directory = dependency.slice(markerIndex + marker.length);
  return directory === sibling.directory || directory.endsWith(`/${sibling.directory}`);
};

export function pythonProjectInfo(
  source: string,
  toml: { parse(source: string): unknown },
): { name: string; version: string; private: boolean } {
  const document = toml.parse(source) as { tool?: { "dbx-tools"?: { private?: boolean } } };
  const project = projectTable(document);
  if (typeof project.name !== "string" || !project.name) {
    throw new Error("Missing Python project name");
  }
  if (typeof project.version !== "string" || !project.version) {
    throw new Error("Missing Python project version");
  }
  return {
    name: project.name,
    version: project.version,
    private: document.tool?.["dbx-tools"]?.private === true,
  };
}

export function preparePythonProjectForPublication(
  source: string,
  options: {
    readonly packages: readonly { readonly directory: string; readonly name: string }[];
    readonly toml: { parse(source: string): unknown; stringify(document: unknown): string };
    readonly version: string;
  },
): string {
  const marker = source.startsWith("# ") ? source.slice(0, source.indexOf("\n")) : undefined;
  const document = options.toml.parse(source);
  const project = projectTable(document);
  if (project.version !== options.version) {
    throw new Error(
      `Python project version ${String(project.version)} does not match release ${options.version}`,
    );
  }
  const dependencies = project.dependencies;
  if (dependencies !== undefined && !Array.isArray(dependencies)) {
    throw new Error("Python project dependencies must be an array");
  }
  if (dependencies) {
    project.dependencies = dependencies.map((dependency) => {
      if (typeof dependency !== "string") {
        throw new Error("Python project dependencies must be strings");
      }
      const sibling = options.packages.find((candidate) => directSibling(dependency, candidate));
      return sibling ? `${sibling.name}==${options.version}` : dependency;
    });
  }
  const body = options.toml.stringify(document).trimEnd();
  return `${marker ? `${marker}\n\n` : ""}${body}\n`;
}
