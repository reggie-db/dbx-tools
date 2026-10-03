/**
 * Deterministic affected release plan derived from manifest and graph changes.
 *
 * @module
 */

import type {
  ReleaseArtifact,
  ReleaseProjectNode,
  ReleaseUnit,
  ReleaseUnitGraph,
} from "./release-catalog.ts";

/** Why a unit entered one release. */
export type ReleaseReason = "direct" | "propagated";

/** One independently versioned unit selected for publication. */
export interface PlannedReleaseUnit {
  readonly id: string;
  readonly component: string;
  readonly oldVersion: string;
  readonly newVersion: string;
  readonly tag: string;
  readonly reason: ReleaseReason;
  readonly sourceHash: string;
}

/** One selected package publication. */
export interface PlannedPackage {
  readonly unit: string;
  readonly identity: string;
  readonly path: string;
  readonly version: string;
}

/** One selected virtual artifact publication. */
export interface PlannedArtifact extends ReleaseArtifact {
  readonly version: string;
}

/** One selected native Rust matrix row and the packages built in that row. */
export interface PlannedRustTarget {
  readonly os: string;
  readonly cpu: string;
  readonly node: string;
  readonly cargo: string;
  readonly runner: string;
  readonly python: string;
  readonly libc: string;
  readonly glibcVersion: string;
  readonly packages: readonly string[];
  readonly binaries: readonly string[];
  readonly features: readonly string[];
}

/** Complete plan persisted as a workflow artifact and used for recovery. */
export interface ReleasePlan {
  readonly schemaVersion: 2;
  readonly units: readonly PlannedReleaseUnit[];
  readonly publishBatches: readonly (readonly string[])[];
  readonly nodePackages: readonly PlannedPackage[];
  readonly pythonPackages: readonly PlannedPackage[];
  readonly rustPackages: readonly PlannedPackage[];
  readonly artifacts: readonly PlannedArtifact[];
  readonly rustTargets: readonly PlannedRustTarget[];
  readonly stages: {
    readonly rust: boolean;
    readonly python: boolean;
    readonly node: boolean;
    readonly github: boolean;
    readonly docs: boolean;
  };
  readonly omittedStages: readonly string[];
}

/** Build the affected plan from the previous and reviewed release graphs. */
export function buildReleasePlan(
  current: ReleaseUnitGraph,
  previous?: ReleaseUnitGraph,
): ReleasePlan {
  const previousUnits = new Map(previous?.units.map((unit) => [unit.id, unit]) ?? []);
  const units = current.units.flatMap<PlannedReleaseUnit>((unit) => {
    const old = previousUnits.get(unit.id);
    if (!old || old.version === unit.version) return [];
    return [
      {
        id: unit.id,
        component: unit.component,
        oldVersion: old.version,
        newVersion: unit.version,
        tag: `${unit.component}-v${unit.version}`,
        reason: old.sourceHash === unit.sourceHash ? "propagated" : "direct",
        sourceHash: unit.sourceHash,
      },
    ];
  });
  const selected = new Set(units.map((unit) => unit.id));
  const versions = new Map(units.map((unit) => [unit.id, unit.newVersion]));
  const packagePlan = (language: ReleaseProjectNode["language"]): PlannedPackage[] =>
    current.projects
      .filter(
        (project) =>
          project.publish &&
          project.language === language &&
          project.unit !== undefined &&
          selected.has(project.unit),
      )
      .map((project) => ({
        unit: project.unit!,
        identity: project.identity,
        path: project.path,
        version: versions.get(project.unit!)!,
      }))
      .sort((a, b) => a.identity.localeCompare(b.identity));
  const artifacts = current.artifacts
    .filter((artifact) => artifact.publish && selected.has(artifact.unit))
    .map((artifact) => ({
      ...artifact,
      version: versions.get(artifact.unit)!,
    }));
  const rustPackagesByUnit = new Map<string, string[]>();
  for (const project of current.projects) {
    if (
      project.language === "rust" &&
      project.publish &&
      project.unit &&
      selected.has(project.unit)
    ) {
      rustPackagesByUnit.set(project.unit, [
        ...(rustPackagesByUnit.get(project.unit) ?? []),
        project.identity,
      ]);
    }
  }
  const rustTargets = new Map<string, PlannedRustTarget>();
  for (const artifact of artifacts) {
    const targets = artifact.data?.targets;
    if (!Array.isArray(targets)) continue;
    const binary = artifact.kind === "github-binary";
    for (const value of targets) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const target = value as Record<string, unknown>;
      const required = ["os", "cpu", "node", "cargo", "runner", "python"] as const;
      if (!required.every((field) => typeof target[field] === "string")) continue;
      const key = String(target.node);
      const currentTarget = rustTargets.get(key);
      const packages = [
        ...new Set([
          ...(currentTarget?.packages ?? []),
          ...(rustPackagesByUnit.get(artifact.unit) ?? []),
        ]),
      ].sort();
      const binaries = binary
        ? [
            ...new Set([
              ...(currentTarget?.binaries ?? []),
              ...(typeof artifact.data?.binary === "string" ? [artifact.data.binary] : []),
            ]),
          ].sort()
        : (currentTarget?.binaries ?? []);
      const configuredFeatures = Array.isArray(artifact.data?.features)
        ? artifact.data.features.filter((feature): feature is string => typeof feature === "string")
        : [];
      const crate = typeof artifact.data?.crate === "string" ? artifact.data.crate : undefined;
      const features = binary
        ? [
            ...new Set([
              ...(currentTarget?.features ?? []),
              ...(crate
                ? configuredFeatures.map((feature) => `${crate}/${feature}`)
                : configuredFeatures),
            ]),
          ].sort()
        : [
            ...new Set([
              ...(currentTarget?.features ?? []),
              ...packages.map((pkg) => `${pkg}/uniffi-bindgen`),
            ]),
          ].sort();
      rustTargets.set(key, {
        os: String(target.os),
        cpu: String(target.cpu),
        node: String(target.node),
        cargo: String(target.cargo),
        runner: String(target.runner),
        python: String(target.python),
        libc: typeof target.libc === "string" ? target.libc : "",
        glibcVersion: typeof target.glibcVersion === "string" ? target.glibcVersion : "",
        packages,
        binaries,
        features,
      });
    }
  }
  const plannedRustTargets = [...rustTargets.values()].sort((a, b) => a.node.localeCompare(b.node));
  const publishBatches = current.publishBatches
    .map((batch) => batch.filter((unit) => selected.has(unit)))
    .filter((batch) => batch.length > 0);
  const nodePackages = packagePlan("javascript");
  const pythonPackages = packagePlan("python");
  const rustPackages = packagePlan("rust");
  const stages = {
    rust:
      rustPackages.length > 0 ||
      artifacts.some((artifact) => ["cargo", "github-binary"].includes(artifact.kind)),
    python: pythonPackages.length > 0 || artifacts.some((artifact) => artifact.kind === "pypi"),
    node: nodePackages.length > 0 || artifacts.some((artifact) => artifact.kind === "npm"),
    github: artifacts.some((artifact) => artifact.kind === "github-binary"),
    docs: units.length > 0 || artifacts.some((artifact) => artifact.kind === "documentation"),
  };
  const omittedStages = Object.entries(stages)
    .filter(([, enabled]) => !enabled)
    .map(([name]) => name);
  return {
    schemaVersion: 2,
    units,
    publishBatches,
    nodePackages,
    pythonPackages,
    rustPackages,
    artifacts,
    rustTargets: plannedRustTargets,
    stages,
    omittedStages,
  };
}

/** Reconstruct a one-component plan for an idempotent manual recovery. */
export function buildRecoveryReleasePlan(
  current: ReleaseUnitGraph,
  component: string,
  version: string,
): ReleasePlan {
  const unit = current.units.find(
    (candidate) => candidate.component === component || candidate.id === component,
  );
  if (!unit) throw new Error(`Unknown recovery component ${component}`);
  if (unit.version !== version) {
    throw new Error(`Recovery version ${version} does not match ${unit.component}@${unit.version}`);
  }
  const previous: ReleaseUnitGraph = {
    ...current,
    units: current.units.map((candidate) =>
      candidate.id === unit.id
        ? { ...candidate, version: "0.0.0", sourceHash: candidate.sourceHash }
        : candidate,
    ),
  };
  return buildReleasePlan(current, previous);
}

/** Validate that graph units and package identities are internally consistent. */
export function validateReleasePlanGraph(graph: ReleaseUnitGraph): void {
  const units = new Map<string, ReleaseUnit>();
  for (const unit of graph.units) {
    if (units.has(unit.id)) throw new Error(`Duplicate release plan unit ${unit.id}`);
    units.set(unit.id, unit);
  }
  for (const project of graph.projects) {
    if (project.unit && !units.has(project.unit)) {
      throw new Error(`Release project ${project.identity} has unknown unit ${project.unit}`);
    }
  }
  for (const artifact of graph.artifacts) {
    if (!units.has(artifact.unit)) {
      throw new Error(`Release artifact ${artifact.id} has unknown unit ${artifact.unit}`);
    }
  }
}
