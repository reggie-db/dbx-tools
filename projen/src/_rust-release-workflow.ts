/** Rust release planning, candidate configuration, and Cargo promotion. */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextFile, javascript } from "projen";
import { JobPermission, type Job } from "projen/lib/github/workflows-model";
import { UNIFFI_BINDGEN_FEATURE, type RustProject } from "./_rust-project.ts";
import type {
  DBXToolsRustWorkspaceOptions,
  RustBindingMapping,
  RustReleaseOs,
  UniFFIReleaseTarget,
} from "./project-rs.ts";
import { RELEASE_VERSION, releaseSourceSteps } from "./release-dispatch.ts";
import { releasePublishCondition } from "./release.ts";

const require = createRequire(import.meta.url);
type RustPackageDependencyResolver = (pkg: RustProject) => RustProject[];

function taskSource(name: string): string {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(sourceDirectory, `../tasks/${name}`),
    resolve(sourceDirectory, `../../tasks/${name}`),
  ];
  const source = candidates.find(existsSync);
  if (!source) throw new Error(`Could not locate tasks/${name}`);
  return readFileSync(source, "utf8");
}

function smolTomlSource(name: "dist/index.cjs" | "LICENSE"): string {
  const entry = require.resolve("smol-toml");
  return readFileSync(
    resolve(dirname(entry), name === "LICENSE" ? "../LICENSE" : "index.cjs"),
    "utf8",
  );
}

export function orderRustBindings(bindings: readonly RustBindingMapping[]): RustBindingMapping[] {
  const ordered: RustBindingMapping[] = [];
  const visiting = new Set<string>();
  const completed = new Set<string>();
  const visit = (binding: RustBindingMapping): void => {
    if (completed.has(binding.crate)) return;
    if (visiting.has(binding.crate)) {
      throw new Error(`Cyclic Rust binding dependency: ${binding.crate}`);
    }
    visiting.add(binding.crate);
    for (const name of binding.dependencies ?? []) {
      const dependency = bindings.find((candidate) => candidate.crate === name);
      if (!dependency) throw new Error(`Missing Rust binding dependency: ${name}`);
      visit(dependency);
    }
    visiting.delete(binding.crate);
    completed.add(binding.crate);
    ordered.push(binding);
  };
  for (const binding of bindings) visit(binding);
  return ordered;
}

export interface RustReleaseBinding extends RustBindingMapping {
  readonly node: string;
  readonly python: string;
  readonly nodePackage: string;
  readonly pythonPackage: string;
}

export interface RustReleaseBinaryPlan {
  readonly crate: string;
  readonly binary: string;
  readonly excludedOs: readonly RustReleaseOs[];
  readonly requiredFeatures: readonly string[];
}

export interface RustReleaseTargetPlan {
  readonly runner: string;
  readonly cargo: string;
  readonly node: string;
  readonly python: string;
  readonly os: RustReleaseOs;
  readonly cpu: string;
  readonly libc: string;
  readonly glibcVersion: string;
  readonly packages: readonly string[];
  readonly binaries: readonly string[];
  readonly features: readonly string[];
  readonly localFeatures: readonly string[];
}

/** Generated release inputs shared by GitHub-hosted and local target builds. */
export interface RustReleaseConfiguration {
  readonly releaseRustVersion: string;
  readonly usesCargoLock: boolean;
  readonly bindings: readonly RustReleaseBinding[];
  readonly binaries: readonly RustReleaseBinaryPlan[];
  readonly targets: readonly RustReleaseTargetPlan[];
}

export interface RustReleasePlan {
  readonly releaseRustVersion: string;
  readonly releaseTask: string;
  readonly bindings: readonly RustReleaseBinding[];
  readonly nodeBindings: readonly RustReleaseBinding[];
  readonly releaseBinaries: readonly RustReleaseBinaryPlan[];
  readonly publicCrates: readonly string[];
  readonly targets: readonly RustReleaseTargetPlan[];
  readonly hasPythonBindings: boolean;
  readonly usesCargoLock: boolean;
  readonly usePreinstalledWindowsRust: boolean;
  readonly hasTargetOutputs: boolean;
}

function releaseTargetPlan(
  target: UniFFIReleaseTarget,
  packages: readonly RustProject[],
  binaries: readonly string[],
  features: readonly string[],
  localFeatures: readonly string[],
): RustReleaseTargetPlan {
  const packageNames = packages.map((pkg) => pkg.crateName).sort();
  const sortedBinaries = [...new Set(binaries)].sort();
  const sortedFeatures = [...new Set(features)].sort();
  return {
    runner: target.runner,
    cargo: target.cargo,
    node: target.node,
    python: target.python,
    os: target.os,
    cpu: target.cpu,
    libc: target.libc ?? "",
    glibcVersion: target.glibcVersion ?? "",
    packages: packageNames,
    binaries: sortedBinaries,
    features: sortedFeatures,
    localFeatures: [...new Set(localFeatures)].sort(),
  };
}

export function planRustRelease(
  project: javascript.NodeProject,
  options: DBXToolsRustWorkspaceOptions,
  targets: readonly UniFFIReleaseTarget[],
  packages: readonly RustProject[],
  bindingMappings: readonly RustBindingMapping[],
  packageDependencies: RustPackageDependencyResolver,
): RustReleasePlan {
  const releaseRustVersion = options.releaseRustVersion ?? "stable";
  const bindings = bindingMappings.map((binding) => ({
    ...binding,
    node: binding.node ?? "",
    python: binding.python ?? "",
    nodePackage: binding.nodePackage ?? "",
    pythonPackage: binding.pythonPackage ?? "",
  }));
  const releaseBinaries = packages.flatMap((pkg) => [
    ...(pkg.packageOptions.release
      ? [
          {
            crate: pkg.crateName,
            binary: pkg.packageOptions.binaryName ?? pkg.crateName,
            excludedOs: pkg.packageOptions.releaseExcludeOs ?? [],
            requiredFeatures: [],
          },
        ]
      : []),
    ...(pkg.packageOptions.binaries ?? [])
      .filter((binary) => binary.release)
      .map((binary) => ({
        crate: pkg.crateName,
        binary: binary.name,
        excludedOs: binary.releaseExcludeOs ?? [],
        requiredFeatures: binary.requiredFeatures ?? [],
      })),
  ]);
  const publicCrates = orderRustBindings(
    packages
      .filter((pkg) => !pkg.packageOptions.private)
      .map((pkg) => ({
        crate: pkg.crateName,
        rust: pkg.outdir,
        dependencies: packageDependencies(pkg).map((dependency) => dependency.crateName),
      })),
  ).map((pkg) => pkg.crate);
  const bindingPackages = packages.filter((pkg) =>
    bindings.some((binding) => binding.crate === pkg.crateName),
  );
  const releaseTargets = targets.flatMap((target) => {
    const selectedBinaries = releaseBinaries.filter(
      (binary) => !binary.excludedOs.includes(target.os),
    );
    const binaryPackages = packages.filter((pkg) =>
      selectedBinaries.some((binary) => binary.crate === pkg.crateName),
    );
    const selectedPackages = [...new Set([...bindingPackages, ...binaryPackages])];
    if (!selectedPackages.length) return [];
    const features = [
      ...bindingPackages.map((pkg) => `${pkg.crateName}/${UNIFFI_BINDGEN_FEATURE}`),
      ...selectedBinaries.flatMap((binary) =>
        binary.requiredFeatures.map((feature) => `${binary.crate}/${feature}`),
      ),
    ];
    const localFeatures = selectedPackages.flatMap((pkg) =>
      (pkg.packageOptions.releaseLocalFeatures ?? []).map(
        (feature) => `${pkg.crateName}/${feature}`,
      ),
    );
    return [
      releaseTargetPlan(
        target,
        selectedPackages,
        selectedBinaries.map((binary) => binary.binary),
        features,
        localFeatures,
      ),
    ];
  });
  const hasTargetOutputs = releaseTargets.length > 0;
  if (hasTargetOutputs && targets.length === 0) {
    throw new Error("Rust release requires at least one target");
  }
  return {
    releaseRustVersion,
    releaseTask: ".projen/uniffi-release.mjs",
    bindings,
    nodeBindings: bindings.filter((binding) => Boolean(binding.node && binding.nodePackage)),
    releaseBinaries,
    publicCrates,
    targets: releaseTargets,
    hasPythonBindings: bindings.some((binding) => binding.python),
    usesCargoLock: existsSync(join(project.outdir, "Cargo.lock")),
    usePreinstalledWindowsRust: releaseRustVersion === "stable",
    hasTargetOutputs,
  };
}
export function configureRustReleaseTask(
  project: javascript.NodeProject,
  plan: RustReleasePlan,
): void {
  new TextFile(project, ".projen/rust-release.json", {
    lines: JSON.stringify(
      {
        releaseRustVersion: plan.releaseRustVersion,
        usesCargoLock: plan.usesCargoLock,
        bindings: plan.bindings,
        binaries: plan.releaseBinaries,
        targets: plan.targets,
      } satisfies RustReleaseConfiguration,
      null,
      2,
    ).split("\n"),
  });
  const bindingSupportFiles = [
    plan.releaseTask,
    ".projen/uniffi-python.js",
    ".projen/smol-toml.cjs",
    ".projen/smol-toml.LICENSE",
  ] as const;
  if (plan.bindings.length) {
    new TextFile(project, plan.releaseTask, {
      lines: taskSource("uniffi-release.mjs").trimEnd().split("\n"),
    });
    new TextFile(project, bindingSupportFiles[1], {
      lines: taskSource("uniffi-python.js").trimEnd().split("\n"),
    });
    new TextFile(project, bindingSupportFiles[2], {
      lines: smolTomlSource("dist/index.cjs").trimEnd().split("\n"),
    });
    new TextFile(project, bindingSupportFiles[3], {
      lines: smolTomlSource("LICENSE").trimEnd().split("\n"),
    });
  } else {
    for (const path of bindingSupportFiles) project.tryRemoveFile(path);
  }
  project.tryRemoveFile(".projen/rust-release.mjs");
}

export function rustCargoPublishJob(plan: RustReleasePlan): Job {
  return {
    if: releasePublishCondition("cargo", ["needs.verify-context.result == 'success'"]),
    needs: ["verify-context"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ },
    steps: [
      ...releaseSourceSteps(),
      {
        name: "Setup Rust",
        uses: `dtolnay/rust-toolchain@${plan.releaseRustVersion}`,
      },
      {
        name: "Publish public crates",
        env: {
          RELEASE_VERSION,
          CARGO_REGISTRY_TOKEN: "${{ secrets.CARGO_REGISTRY_TOKEN }}",
        },
        run: plan.publicCrates
          .map((crate) =>
            [
              `if cargo info "${crate}@$RELEASE_VERSION" >/dev/null 2>&1; then`,
              `  echo "skip published ${crate}@$RELEASE_VERSION"`,
              "else",
              `  cargo publish --package "${crate}" --registry crates-io --locked`,
              "fi",
            ].join("\n"),
          )
          .join("\n"),
      },
    ],
  };
}
