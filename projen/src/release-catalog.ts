/**
 * Cross-language release-unit ownership and dependency graph.
 *
 * The catalog is the version lookup and release-planning seam shared by every
 * generated project. Fixed mode preserves the root VERSION contract while the
 * same registrations and graph are exercised before independent versions are
 * enabled.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { Component, JsonFile, type Project } from "projen";
import { toPosix } from "./packages.ts";
import { readWorkspaceVersion } from "./workspace-version.ts";

/** Version source used by the generated workspace. */
export type DBXToolsVersioningMode = "fixed" | "independent";

/** Runtime family represented by a release project. */
export type ReleaseProjectLanguage = "javascript" | "python" | "rust";

/** Publishable output owned by one release unit. */
export type ReleaseArtifactKind = "npm" | "pypi" | "cargo" | "github-binary" | "documentation";

/** Relationship between two projects or release units. */
export type ReleaseEdgeKind =
  | "runtime"
  | "peer"
  | "optional"
  | "bundled"
  | "build"
  | "test"
  | "development"
  | "generated"
  | "publish";

/** When a dependency release requires a dependent release. */
export type ReleasePropagation = "never" | "outside-range" | "always";

/** Explicit grouping rule applied after every project has registered. */
export interface ReleaseUnitRule {
  readonly id: string;
  readonly component?: string;
  readonly projectPaths?: readonly string[];
  readonly projectIdentities?: readonly string[];
}

/** Root catalog configuration. */
export interface DBXToolsReleaseCatalogOptions {
  readonly mode?: DBXToolsVersioningMode;
  readonly manifestFile?: string;
  readonly graphFile?: string;
  readonly releasePleaseConfigFile?: string;
  readonly bootstrapSha?: string;
  readonly units?: readonly ReleaseUnitRule[];
  readonly externalProjects?: readonly ExternalReleaseProjectRegistration[];
}

/** Dependency supplied by an ecosystem adapter. */
export interface ReleaseDependencyInput {
  readonly target: string;
  readonly kind: ReleaseEdgeKind;
  readonly requirement?: string;
  readonly propagation?: ReleasePropagation;
  readonly publishOrder?: boolean;
  readonly internal?: boolean;
}

/** Project registration supplied by an ecosystem adapter. */
export interface ReleaseProjectRegistration {
  readonly language: ReleaseProjectLanguage;
  readonly identity: string | (() => string);
  readonly publish?: boolean | (() => boolean);
  readonly unit?: string;
  readonly component?: string;
  readonly sourcePaths?: readonly string[];
  readonly dependencies?:
    readonly ReleaseDependencyInput[] | (() => readonly ReleaseDependencyInput[]);
}

/** Project-like workspace member synthesized outside the attached Projen tree. */
export interface ExternalReleaseProjectRegistration {
  readonly path: string;
  readonly language: ReleaseProjectLanguage;
  readonly identity: string;
  readonly publish?: boolean;
  readonly unit?: string;
  readonly component?: string;
  readonly sourcePaths?: readonly string[];
  readonly dependencies?: readonly ReleaseDependencyInput[];
}

/** Virtual publication target owned by a release unit. */
export interface ReleaseArtifactRegistration {
  readonly id: string;
  readonly kind: ReleaseArtifactKind;
  readonly name: string;
  readonly path?: string;
  readonly generated?: boolean;
  readonly publish?: boolean;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Serialized project node. */
export interface ReleaseProjectNode {
  readonly id: string;
  readonly identity: string;
  readonly language: ReleaseProjectLanguage;
  readonly path: string;
  readonly unit?: string;
  readonly publish: boolean;
  readonly sourceHash: string;
}

/** Serialized publication target. */
export interface ReleaseArtifact {
  readonly id: string;
  readonly kind: ReleaseArtifactKind;
  readonly name: string;
  readonly unit: string;
  readonly path?: string;
  readonly generated: boolean;
  readonly publish: boolean;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Serialized dependency edge. */
export interface ReleaseDependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: ReleaseEdgeKind;
  readonly requirement?: string;
  readonly propagation: ReleasePropagation;
  readonly publishOrder: boolean;
}

/** Serialized release unit. */
export interface ReleaseUnit {
  readonly id: string;
  readonly component: string;
  readonly version: string;
  readonly projects: readonly string[];
  readonly artifacts: readonly string[];
  readonly sourceHash: string;
}

/** Generated execution graph consumed by validation and release tasks. */
export interface ReleaseUnitGraph {
  readonly schemaVersion: 1;
  readonly mode: DBXToolsVersioningMode;
  readonly units: readonly ReleaseUnit[];
  readonly projects: readonly ReleaseProjectNode[];
  readonly artifacts: readonly ReleaseArtifact[];
  readonly edges: readonly ReleaseDependencyEdge[];
  readonly publishBatches: readonly (readonly string[])[];
}

interface RegisteredProject {
  readonly project: Project;
  readonly registration: ReleaseProjectRegistration;
}

interface RegisteredArtifact extends ReleaseArtifactRegistration {
  readonly unit: string;
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".projen",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "dist",
  "lib",
  "node_modules",
  "target",
]);

const IGNORED_FILES = new Set([
  "Cargo.lock",
  "Cargo.toml",
  "package.json",
  "pyproject.toml",
  "uv.lock",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/** Stable default component id for one publishable project. */
export function defaultReleaseUnitId(language: ReleaseProjectLanguage, identity: string): string {
  const prefix = language === "javascript" ? "node" : language === "python" ? "python" : "rs";
  const unscoped = identity.includes("/")
    ? identity.slice(identity.lastIndexOf("/") + 1)
    : identity;
  const name = unscoped
    .replace(/^dbx-tools-/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (!name) throw new Error(`Cannot derive a release unit from ${identity}`);
  return `${prefix}-${name}`;
}

/** Default propagation policy for an ecosystem dependency. */
export function defaultReleasePropagation(kind: ReleaseEdgeKind): ReleasePropagation {
  if (kind === "bundled" || kind === "generated") return "always";
  if (kind === "runtime" || kind === "peer" || kind === "optional") return "outside-range";
  return "never";
}

/** Whether an edge participates in publication ordering by default. */
export function defaultPublishOrder(kind: ReleaseEdgeKind): boolean {
  return !["test", "development"].includes(kind);
}

/** Read one component version, falling back to fixed workspace compatibility. */
export function readReleaseUnitVersion(
  root: string,
  component: string,
  manifestFile = ".release-please-manifest.json",
): string {
  const path = resolve(root, manifestFile);
  if (!existsSync(path)) return readWorkspaceVersion(root);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const version = parsed[`.release-units/${component}`];
  if (typeof version !== "string") {
    throw new Error(`Release Please manifest is missing .release-units/${component}`);
  }
  return version;
}

/**
 * Root release catalog shared by every generated language project.
 *
 * Registrations remain mutable until synthesis. The serialized graph is lazy,
 * so repository mixins and workspace components may add ownership and edges
 * after project construction.
 */
export class DBXToolsReleaseCatalog extends Component {
  readonly mode: DBXToolsVersioningMode;
  readonly manifestFile: string;
  readonly graphFile: string;
  readonly releasePleaseConfigFile: string;
  readonly bootstrapSha?: string;

  private readonly projects = new Map<Project, RegisteredProject>();
  private readonly externalProjects = new Map<string, ExternalReleaseProjectRegistration>();
  private readonly artifacts = new Map<string, RegisteredArtifact>();
  private readonly explicitDependencies: Array<{
    from: string;
    dependency: ReleaseDependencyInput;
  }> = [];
  private readonly rules: ReleaseUnitRule[];
  private readonly markerFiles = new Set<string>();

  constructor(project: Project, options: DBXToolsReleaseCatalogOptions = {}) {
    super(project);
    this.mode = options.mode ?? "fixed";
    this.manifestFile = options.manifestFile ?? ".release-please-manifest.json";
    this.graphFile = options.graphFile ?? ".projen/release-units.json";
    this.releasePleaseConfigFile = options.releasePleaseConfigFile ?? "release-please-config.json";
    this.bootstrapSha = options.bootstrapSha;
    this.rules = [...(options.units ?? [])];
    for (const external of options.externalProjects ?? []) this.registerExternalProject(external);
    new JsonFile(project, this.graphFile, {
      marker: false,
      readonly: true,
      obj: () => this.graph(),
    });
    if (this.mode === "independent") {
      new JsonFile(project, this.releasePleaseConfigFile, {
        marker: false,
        readonly: true,
        obj: () => this.releasePleaseConfig(),
      });
      project
        .addTask("release:bootstrap", {
          description: "Bootstrap Release Please state from release units",
        })
        .exec("bun node_modules/@dbx-tools/projen/tasks/release-bootstrap.ts");
    }
  }

  /** Register one attached Projen project. */
  registerProject(project: Project, registration: ReleaseProjectRegistration): void {
    if (this.projects.has(project)) {
      throw new Error(`Release project already registered: ${project.outdir}`);
    }
    this.projects.set(project, { project, registration });
  }

  /** Register a workspace member synthesized outside the attached project tree. */
  registerExternalProject(registration: ExternalReleaseProjectRegistration): void {
    const path = toPosix(registration.path).replace(/^\.\//, "");
    if (!path || path === ".") throw new Error("External release project requires a child path");
    if (this.externalProjects.has(path)) {
      throw new Error(`External release project already registered: ${path}`);
    }
    this.externalProjects.set(path, { ...registration, path });
  }

  /** Replace grouping metadata for an already registered project. */
  configureProject(
    project: Project,
    options: Pick<ReleaseProjectRegistration, "unit" | "component" | "publish" | "sourcePaths">,
  ): void {
    const current = this.projects.get(project);
    if (!current) throw new Error(`Release project is not registered: ${project.outdir}`);
    this.projects.set(project, {
      project,
      registration: { ...current.registration, ...options },
    });
  }

  /** Add an explicit grouping rule before synthesis. */
  addUnit(rule: ReleaseUnitRule): void {
    if (this.rules.some((candidate) => candidate.id === rule.id)) {
      throw new Error(`Duplicate release unit: ${rule.id}`);
    }
    this.rules.push(rule);
  }

  /** Register a generated or otherwise virtual artifact. */
  registerArtifact(unit: string, artifact: ReleaseArtifactRegistration): void {
    if (this.artifacts.has(artifact.id)) {
      throw new Error(`Duplicate release artifact: ${artifact.id}`);
    }
    this.artifacts.set(artifact.id, { ...artifact, unit });
  }

  /** Add an explicit project or unit dependency. */
  addDependency(from: string, dependency: ReleaseDependencyInput): void {
    this.explicitDependencies.push({ from, dependency: { ...dependency, internal: true } });
  }

  /** Current version for a registered project. */
  versionFor(project: Project): string {
    const registered = this.projects.get(project);
    if (!registered) throw new Error(`Release project is not registered: ${project.outdir}`);
    if (!resolveValue(registered.registration.publish ?? true)) {
      return this.mode === "independent" ? "0.0.0" : readWorkspaceVersion(this.project.outdir);
    }
    return this.versionForUnit(this.unitFor(registered));
  }

  /** Stable unit, component, and version identity for a registered project. */
  releaseIdentityFor(project: Project): {
    id: string;
    component: string;
    version: string;
  } {
    const registered = this.projects.get(project);
    if (!registered) throw new Error(`Release project is not registered: ${project.outdir}`);
    const id = this.unitFor(registered);
    return {
      id,
      component: this.componentFor(registered, id),
      version: this.versionFor(project),
    };
  }

  /** Current version for a project selected by its repository-relative path. */
  versionForPath(path: string): string {
    const normalized = toPosix(path).replace(/^\.\//, "") || ".";
    const attached = [...this.projects.values()].find(
      (registered) => this.projectId(registered.project) === normalized,
    );
    if (attached) return this.versionFor(attached.project);
    const external = this.externalProjects.get(normalized);
    if (!external) {
      if (this.mode === "fixed") return readWorkspaceVersion(this.project.outdir);
      throw new Error(`Release project path is not registered: ${normalized}`);
    }
    if (external.publish === false) {
      return this.mode === "independent" ? "0.0.0" : readWorkspaceVersion(this.project.outdir);
    }
    const unit =
      external.unit ??
      this.rules.find(
        (rule) =>
          rule.projectPaths?.includes(normalized) ||
          rule.projectIdentities?.includes(external.identity),
      )?.id ??
      defaultReleaseUnitId(external.language, external.identity);
    return this.versionForUnit(unit);
  }

  /** Resolve a version before the corresponding Projen project is constructed. */
  versionForRegistration(
    language: ReleaseProjectLanguage,
    identity: string,
    path: string,
    unit?: string,
  ): string {
    const normalized = toPosix(path).replace(/^\.\//, "") || ".";
    const resolvedUnit =
      unit ??
      this.rules.find(
        (rule) =>
          rule.projectPaths?.includes(normalized) || rule.projectIdentities?.includes(identity),
      )?.id ??
      defaultReleaseUnitId(language, identity);
    return this.versionForUnit(resolvedUnit);
  }

  /** Current version for a release unit. */
  versionForUnit(unit: string): string {
    if (this.mode === "fixed") return readWorkspaceVersion(this.project.outdir);
    const component = this.rules.find((rule) => rule.id === unit)?.component ?? unit;
    const versions = this.readIndependentVersions();
    const key = `.release-units/${component}`;
    const version = versions[key];
    if (!version) throw new Error(`Release Please manifest is missing ${key}`);
    return version;
  }

  /** Build and validate the normalized release graph. */
  graph(): ReleaseUnitGraph {
    const attachedProjects = [...this.projects.values()].map((registered) =>
      this.projectNode(registered),
    );
    const externalProjects = [...this.externalProjects.values()].map((registered) =>
      this.externalProjectNode(registered),
    );
    const projects = [...attachedProjects, ...externalProjects].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const projectsByIdentity = new Map<string, ReleaseProjectNode[]>();
    for (const project of projects) {
      projectsByIdentity.set(project.identity, [
        ...(projectsByIdentity.get(project.identity) ?? []),
        project,
      ]);
    }
    const projectById = new Map(projects.map((project) => [project.id, project]));
    if (projectById.size !== projects.length) {
      throw new Error("Release project paths must be unique");
    }
    const componentByProjectId = new Map<string, string>();
    for (const registered of this.projects.values()) {
      const id = this.projectId(registered.project);
      const node = projectById.get(id);
      if (node?.unit) componentByProjectId.set(id, this.componentFor(registered, node.unit));
    }
    for (const registered of this.externalProjects.values()) {
      const node = projectById.get(registered.path);
      if (node?.unit) componentByProjectId.set(node.id, registered.component ?? node.unit);
    }
    const units = new Map<string, { component: string; projects: string[]; artifacts: string[] }>();

    for (const project of projects) {
      if (!project.unit) continue;
      const component = componentByProjectId.get(project.id) ?? project.unit;
      const current = units.get(project.unit) ?? { component, projects: [], artifacts: [] };
      if (current.component !== component) {
        throw new Error(`Release unit ${project.unit} has conflicting components`);
      }
      current.projects.push(project.id);
      units.set(project.unit, current);
    }

    const artifacts = [...this.artifacts.values()]
      .map<ReleaseArtifact>((artifact) => {
        if (!units.has(artifact.unit)) {
          throw new Error(`Release artifact ${artifact.id} has unknown owner ${artifact.unit}`);
        }
        units.get(artifact.unit)!.artifacts.push(artifact.id);
        return {
          id: artifact.id,
          kind: artifact.kind,
          name: artifact.name,
          unit: artifact.unit,
          ...(artifact.path ? { path: artifact.path } : {}),
          generated: artifact.generated ?? false,
          publish: artifact.publish !== false,
          ...(artifact.data ? { data: artifact.data } : {}),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    const components = new Map<string, string>();
    for (const [id, unit] of units) {
      const owner = components.get(unit.component);
      if (owner && owner !== id) {
        throw new Error(`Release component ${unit.component} is owned by ${owner} and ${id}`);
      }
      components.set(unit.component, id);
    }

    const edges = this.dependencies(projectsByIdentity, projectById);
    const unitEdges = edges.filter((edge) => edge.publishOrder && edge.from !== edge.to);
    const batches = publicationBatches([...units.keys()], unitEdges);
    const serializedUnits = [...units.entries()]
      .map<ReleaseUnit>(([id, unit]) => {
        const hashes = unit.projects
          .map((projectId) => projectById.get(projectId)?.sourceHash)
          .filter((hash): hash is string => Boolean(hash));
        return {
          id,
          component: unit.component,
          version: this.versionForResolvedUnit(id, unit.component),
          projects: [...unit.projects].sort(),
          artifacts: [...unit.artifacts].sort(),
          sourceHash: hashStrings(hashes),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    return {
      schemaVersion: 1,
      mode: this.mode,
      units: serializedUnits,
      projects,
      artifacts,
      edges,
      publishBatches: batches,
    };
  }

  /** Generated Release Please manifest-mode configuration. */
  releasePleaseConfig(): Record<string, unknown> {
    return {
      $schema:
        "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
      "release-type": "simple",
      "separate-pull-requests": false,
      "include-component-in-tag": true,
      "include-v-in-tag": true,
      ...(this.bootstrapSha ? { "bootstrap-sha": this.bootstrapSha } : {}),
      packages: Object.fromEntries(
        this.graph().units.map((unit) => [
          `.release-units/${unit.component}`,
          {
            "release-type": "simple",
            "package-name": unit.id,
            component: unit.component,
            "changelog-path": "CHANGELOG.md",
            "version-file": "version.txt",
          },
        ]),
      ),
    };
  }

  public override preSynthesize(): void {
    const graph = this.graph();
    if (this.mode === "fixed") return;
    for (const unit of graph.units) {
      const path = `.release-units/${unit.component}/source.json`;
      if (this.markerFiles.has(path)) continue;
      this.markerFiles.add(path);
      new JsonFile(this.project, path, {
        marker: false,
        readonly: true,
        obj: () => {
          const current = this.graph().units.find((candidate) => candidate.id === unit.id);
          if (!current) throw new Error(`Release unit disappeared during synthesis: ${unit.id}`);
          return {
            schemaVersion: 1,
            unit: current.id,
            component: current.component,
            sourceHash: current.sourceHash,
          };
        },
      });
    }
  }

  private projectNode(registered: RegisteredProject): ReleaseProjectNode {
    const identity = resolveValue(registered.registration.identity);
    const publish = resolveValue(registered.registration.publish ?? true);
    const path = toPosix(relative(this.project.outdir, registered.project.outdir)) || ".";
    const unit = publish ? this.unitFor(registered, identity, path) : undefined;
    const sourcePaths = registered.registration.sourcePaths?.length
      ? registered.registration.sourcePaths.map((sourcePath) =>
          resolve(this.project.outdir, sourcePath),
        )
      : [registered.project.outdir];
    return {
      id: this.projectId(registered.project),
      identity,
      language: registered.registration.language,
      path,
      ...(unit ? { unit } : {}),
      publish,
      sourceHash: hashPaths(this.project.outdir, sourcePaths),
    };
  }

  private externalProjectNode(
    registration: ExternalReleaseProjectRegistration,
  ): ReleaseProjectNode {
    const publish = registration.publish !== false;
    const unit = publish
      ? (registration.unit ??
        this.rules.find(
          (candidate) =>
            candidate.projectPaths?.includes(registration.path) ||
            candidate.projectIdentities?.includes(registration.identity),
        )?.id ??
        defaultReleaseUnitId(registration.language, registration.identity))
      : undefined;
    const sourcePaths = (registration.sourcePaths ?? [registration.path]).map((sourcePath) =>
      resolve(this.project.outdir, sourcePath),
    );
    return {
      id: registration.path,
      identity: registration.identity,
      language: registration.language,
      path: registration.path,
      ...(unit ? { unit } : {}),
      publish,
      sourceHash: hashPaths(this.project.outdir, sourcePaths),
    };
  }

  private unitFor(
    registered: RegisteredProject,
    identity = resolveValue(registered.registration.identity),
    path = toPosix(relative(this.project.outdir, registered.project.outdir)) || ".",
  ): string {
    if (registered.registration.unit) return registered.registration.unit;
    const rule = this.rules.find(
      (candidate) =>
        candidate.projectPaths?.includes(path) || candidate.projectIdentities?.includes(identity),
    );
    return rule?.id ?? defaultReleaseUnitId(registered.registration.language, identity);
  }

  private componentFor(registered: RegisteredProject, unit: string): string {
    return (
      registered.registration.component ??
      this.rules.find((rule) => rule.id === unit)?.component ??
      unit
    );
  }

  private projectId(project: Project): string {
    return toPosix(relative(this.project.outdir, project.outdir)) || ".";
  }

  private dependencies(
    byIdentity: ReadonlyMap<string, readonly ReleaseProjectNode[]>,
    byId: ReadonlyMap<string, ReleaseProjectNode>,
  ): ReleaseDependencyEdge[] {
    const edges = new Map<string, ReleaseDependencyEdge>();
    const add = (from: ReleaseProjectNode, dependency: ReleaseDependencyInput): void => {
      const identityMatches = byIdentity.get(dependency.target) ?? [];
      const sameLanguage = identityMatches.filter(
        (candidate) => candidate.language === from.language,
      );
      const target =
        byId.get(dependency.target) ??
        (sameLanguage.length === 1
          ? sameLanguage[0]
          : identityMatches.length === 1
            ? identityMatches[0]
            : undefined);
      if (!target) {
        if (dependency.internal) {
          const reason = identityMatches.length > 1 ? "ambiguous" : "unknown";
          throw new Error(
            `${from.identity} references ${reason} internal project ${dependency.target}`,
          );
        }
        return;
      }
      if (!from.unit || !target.unit) return;
      const edge: ReleaseDependencyEdge = {
        from: from.unit,
        to: target.unit,
        kind: dependency.kind,
        ...(dependency.requirement ? { requirement: dependency.requirement } : {}),
        propagation: dependency.propagation ?? defaultReleasePropagation(dependency.kind),
        publishOrder: dependency.publishOrder ?? defaultPublishOrder(dependency.kind),
      };
      const key = [
        edge.from,
        edge.to,
        edge.kind,
        edge.requirement ?? "",
        edge.propagation,
        edge.publishOrder,
      ].join("\0");
      edges.set(key, edge);
    };

    for (const registered of this.projects.values()) {
      const from = byId.get(this.projectId(registered.project));
      if (!from) continue;
      for (const dependency of resolveValue(registered.registration.dependencies ?? [])) {
        add(from, dependency);
      }
    }
    for (const registered of this.externalProjects.values()) {
      const from = byId.get(registered.path);
      if (!from) continue;
      for (const dependency of registered.dependencies ?? []) add(from, dependency);
    }
    for (const explicit of this.explicitDependencies) {
      const matches = byIdentity.get(explicit.from) ?? [];
      const from = byId.get(explicit.from) ?? (matches.length === 1 ? matches[0] : undefined);
      if (!from) throw new Error(`Unknown release dependency source ${explicit.from}`);
      add(from, explicit.dependency);
    }
    return [...edges.values()].sort((a, b) =>
      [a.from, a.to, a.kind].join("\0").localeCompare([b.from, b.to, b.kind].join("\0")),
    );
  }

  private versionForResolvedUnit(unit: string, component: string): string {
    if (this.mode === "fixed") return readWorkspaceVersion(this.project.outdir);
    const key = `.release-units/${component}`;
    const version = this.readIndependentVersions()[key];
    if (!version) throw new Error(`Release Please manifest is missing ${key} for ${unit}`);
    return version;
  }

  private readIndependentVersions(): Record<string, string> {
    const path = resolve(this.project.outdir, this.manifestFile);
    if (!existsSync(path)) throw new Error(`Independent version manifest not found: ${path}`);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Independent version manifest must contain an object: ${path}`);
    }
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => {
        if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
          throw new Error(`Invalid independent version for ${key}: ${String(value)}`);
        }
        return [key, value];
      }),
    );
  }
}

/** Publish dependency batches ordered with dependencies before dependents. */
export function publicationBatches(
  units: readonly string[],
  edges: readonly Pick<ReleaseDependencyEdge, "from" | "to" | "publishOrder">[],
): string[][] {
  const remaining = new Map(units.map((unit) => [unit, new Set<string>()]));
  for (const edge of edges) {
    if (!edge.publishOrder || edge.from === edge.to) continue;
    if (!remaining.has(edge.from) || !remaining.has(edge.to)) {
      throw new Error(`Release edge references an unknown unit: ${edge.from} -> ${edge.to}`);
    }
    remaining.get(edge.from)!.add(edge.to);
  }
  const batches: string[][] = [];
  while (remaining.size > 0) {
    const batch = [...remaining.entries()]
      .filter(([, dependencies]) =>
        [...dependencies].every((dependency) => !remaining.has(dependency)),
      )
      .map(([unit]) => unit)
      .sort();
    if (batch.length === 0) {
      const cycle = [...remaining.keys()].sort().join(", ");
      throw new Error(`Cyclic release publication dependencies: ${cycle}`);
    }
    batches.push(batch);
    for (const unit of batch) remaining.delete(unit);
  }
  return batches;
}

function resolveValue<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

function hashPaths(root: string, paths: readonly string[]): string {
  const files = gitReleaseFiles(root, paths) ?? paths.flatMap((path) => releaseFiles(path)).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(toPosix(relative(root, file)));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function gitReleaseFiles(root: string, paths: readonly string[]): string[] | undefined {
  const relativePaths = paths.map((path) => toPosix(relative(root, path)));
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...relativePaths],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return output
      .split("\0")
      .filter(Boolean)
      .map((path) => resolve(root, path))
      .filter((path) => existsSync(path))
      .filter((path) => paths.some((sourcePath) => trackedReleaseFile(sourcePath, path)))
      .sort();
  } catch {
    return undefined;
  }
}

function trackedReleaseFile(sourcePath: string, path: string): boolean {
  const sourceRelative = toPosix(relative(sourcePath, path));
  if (sourceRelative.startsWith("../") || sourceRelative === "..") return false;
  const parts = sourceRelative.split("/");
  const file = parts.pop();
  if (!file) return false;
  if (parts.some((part) => IGNORED_DIRECTORIES.has(part))) return false;
  if (IGNORED_FILES.has(file) || file.endsWith(".lock") || file.startsWith("tsconfig")) {
    return false;
  }
  return sourceRelative !== "index.ts";
}

function releaseFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.flatMap((entry) => {
    if (entry.isDirectory()) {
      return IGNORED_DIRECTORIES.has(entry.name) ? [] : releaseFiles(join(path, entry.name));
    }
    if (!entry.isFile()) return [];
    if (IGNORED_FILES.has(entry.name) || entry.name.endsWith(".lock")) return [];
    if (entry.name.startsWith("tsconfig") || basename(path) === ".release-units") {
      return [];
    }
    return [join(path, entry.name)];
  });
}

function hashStrings(values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of [...values].sort()) {
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}
