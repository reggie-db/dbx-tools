/** Rust release planning and generated GitHub workflow jobs. */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringUtils } from "@dbx-tools/shared-core";
import { TextFile, javascript } from "projen";
import { JobPermission, type Job, type JobStep } from "projen/lib/github/workflows-model";
import { releaseBinaryAssetName } from "./_release-platform.ts";
import { UNIFFI_BINDGEN_FEATURE, type RustProject } from "./_rust-project.ts";
import { BUN_VERSION } from "./bun-workflow.ts";
import type { DBXToolsJavaScriptProject } from "./project-js.ts";
import type {
  DBXToolsRustWorkspaceOptions,
  RustBindingMapping,
  RustReleaseOs,
  UniFFIReleaseTarget,
} from "./project-rs.ts";
import { defaultReleaseUnitId } from "./release-catalog.ts";
import {
  RELEASE_SHA,
  RELEASE_SUMMARY_FILE,
  RELEASE_TAG,
  RELEASE_VERSION,
  releaseSourceSteps,
} from "./release-dispatch.ts";
import {
  independentReleaseSetupSteps,
  npmPublishEnvironment,
  nodeReleaseSetupSteps,
  releaseArtifactSteps,
  releaseStageCondition,
} from "./release.ts";

const require = createRequire(import.meta.url);

type RustPackageDependencyResolver = (pkg: RustProject) => RustProject[];

const RUST_BUILD_ENV = {
  CARGO_INCREMENTAL: "0",
  CARGO_TERM_COLOR: "always",
} as const;

function timedBash(phase: string, command: string): string {
  return [
    "SECONDS=0",
    `trap 'status=$?; echo "phase=${phase} duration_seconds=$SECONDS status=$status"; exit "$status"' EXIT`,
    command,
  ].join("\n");
}

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

function rustBuildJobIds(plan: RustReleasePlan): string[] {
  return plan.targets.length ? ["rust-build"] : [];
}

function rustBuildResultCondition(plan: RustReleasePlan): string {
  return rustBuildJobIds(plan)
    .map((job) => `needs.${job}.result != 'failure' && needs.${job}.result != 'cancelled'`)
    .join(" && ");
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

function rustBindingCommands(plan: RustReleasePlan, independent: boolean): string[] {
  return plan.bindings.map((binding) => {
    const unit = defaultReleaseUnitId("rust", binding.crate);
    const command = [
      `node ${plan.releaseTask} build`,
      `--crate "${binding.crate}"`,
      `--node "${binding.node}"`,
      `--python "${binding.python}"`,
      `--node-package "${binding.nodePackage}"`,
      `--python-package "${binding.pythonPackage}"`,
      `--python-module "${binding.pythonModule}"`,
      '--cargo-target "${{ matrix.cargo }}"',
      '--node-triple "${{ matrix.node }}"',
      '--python-tag "${{ matrix.python }}"',
      '--os "${{ matrix.os }}"',
      '--cpu "${{ matrix.cpu }}"',
      '--libc "${{ matrix.libc }}"',
      independent
        ? `--version "$(jq -r --arg unit "${unit}" '.units[] | select(.id == $unit) | .newVersion' dist/release-plan.json)"`
        : '--version "$VERSION"',
      `--output "dist/release/${binding.crate}/\${{ matrix.node }}"`,
      "--skip-build",
    ].join(" \\\n  ");
    return independent
      ? [
          `if jq -e --arg unit "${unit}" '.units[] | select(.id == $unit)' dist/release-plan.json >/dev/null; then`,
          `  ${command.replaceAll("\n", "\n  ")}`,
          "fi",
        ].join("\n")
      : command;
  });
}

function rustReleaseBinaryCondition(excludedOs: readonly RustReleaseOs[]): string | undefined {
  return excludedOs.length
    ? `\${{ ${excludedOs.map((os) => `matrix.os != '${os}'`).join(" && ")} }}`
    : undefined;
}

function rustBinaryCommands(plan: RustReleasePlan, independent: boolean): string[] {
  return plan.releaseBinaries.flatMap((pkg) => {
    const unit = defaultReleaseUnitId("rust", pkg.crate);
    const windowsAsset = releaseBinaryAssetName(pkg.binary, "${{ matrix.node }}", "win32");
    const unixAsset = releaseBinaryAssetName(pkg.binary, "${{ matrix.node }}", "linux");
    const commands = [
      `mkdir -p "dist/release/${pkg.crate}/\${{ matrix.node }}/binary/stage"`,
      `SOURCE="target/\${{ matrix.cargo }}/release/${pkg.binary}\${{ matrix.os == 'win32' && '.exe' || '' }}"`,
      `DESTINATION="dist/release/${pkg.crate}/\${{ matrix.node }}/binary/stage/${pkg.binary}\${{ matrix.os == 'win32' && '.exe' || '' }}"`,
      'cp "$SOURCE" "$DESTINATION"',
      'if [ "${{ matrix.os }}" = "win32" ]; then',
      `  7z a "dist/release/${pkg.crate}/\${{ matrix.node }}/binary/${windowsAsset}" "$DESTINATION"`,
      "else",
      `  tar -C "dist/release/${pkg.crate}/\${{ matrix.node }}/binary/stage" -czf "dist/release/${pkg.crate}/\${{ matrix.node }}/binary/${unixAsset}" "${pkg.binary}"`,
      "fi",
      `rm -rf "dist/release/${pkg.crate}/\${{ matrix.node }}/binary/stage"`,
    ];
    const excludedCondition = pkg.excludedOs
      .map((os) => `[ "\${{ matrix.os }}" != "${os}" ]`)
      .join(" && ");
    const platformCommands = excludedCondition
      ? [`if ${excludedCondition}; then`, ...commands.map((command) => `  ${command}`), "fi"]
      : commands;
    return independent
      ? [
          `if jq -e --arg unit "${unit}" '.units[] | select(.id == $unit)' dist/release-plan.json >/dev/null; then`,
          ...platformCommands.map((command) => `  ${command}`),
          "fi",
        ]
      : platformCommands;
  });
}

function rustArtifactSteps(plan: RustReleasePlan): JobStep[] {
  const binaryCrates = [...new Set(plan.releaseBinaries.map((binary) => binary.crate))];
  return [
    ...plan.bindings.flatMap((binding) => [
      ...(binding.node
        ? [
            {
              name: `Upload ${binding.crate} native npm package`,
              uses: "actions/upload-artifact@v7",
              with: {
                name: `${binding.crate}-\${{ matrix.node }}-npm`,
                path: `dist/release/${binding.crate}/\${{ matrix.node }}/npm/*.tgz`,
                "retention-days": 7,
              },
            },
          ]
        : []),
      ...(binding.python
        ? [
            {
              name: `Upload ${binding.crate} Python wheel`,
              uses: "actions/upload-artifact@v7",
              with: {
                name: `${binding.pythonPackage}--\${{ matrix.python }}--python-wheel`,
                path: `dist/release/${binding.crate}/\${{ matrix.node }}/python/*.whl`,
                "retention-days": 7,
              },
            },
          ]
        : []),
    ]),
    ...binaryCrates.map((crate) => {
      const binaries = plan.releaseBinaries.filter((binary) => binary.crate === crate);
      const excludedOs =
        binaries[0]?.excludedOs.filter((os) =>
          binaries.every((binary) => binary.excludedOs.includes(os)),
        ) ?? [];
      return {
        name: `Upload ${crate} release binary`,
        uses: "actions/upload-artifact@v7",
        ...(rustReleaseBinaryCondition(excludedOs)
          ? { if: rustReleaseBinaryCondition(excludedOs) }
          : {}),
        with: {
          name: `${crate}-\${{ matrix.node }}-binary`,
          path: `dist/release/${crate}/\${{ matrix.node }}/binary/*`,
          "retention-days": 7,
        },
      };
    }),
  ];
}

/** Build a Bash loop that preserves matrix values across LF and CRLF runners. */
function matrixArgumentLoop(variable: string, field: string, flag: string): string {
  return `while IFS= read -r ${variable}; do ${variable}="\${${variable}%$'\\r'}"; ${variable}_ARGS+=(${flag} "$${variable}"); done < <(jq -r '.[]' <<<'\${{ toJSON(matrix.${field}) }}')`;
}

function rustCargoBuildCommand(plan: RustReleasePlan): string {
  return [
    "PACKAGE_ARGS=()",
    "FEATURE_ARGS=()",
    matrixArgumentLoop("PACKAGE", "packages", "--package"),
    matrixArgumentLoop("FEATURE", "features", "--features"),
    `cargo build --release --timings "\${PACKAGE_ARGS[@]}" "\${FEATURE_ARGS[@]}"${
      plan.usesCargoLock ? " --locked" : ""
    } --target "\${{ matrix.cargo }}"`,
  ].join("\n");
}

export function rustBuildJob(plan: RustReleasePlan, independentSetup?: readonly JobStep[]): Job {
  const independent = Boolean(independentSetup);
  const bindingCommands = rustBindingCommands(plan, independent);
  const binaryCommands = rustBinaryCommands(plan, independent);
  return {
    if: independentSetup
      ? "${{ needs.release-plan.outputs.rust_targets != '[]' && (github.event_name == 'push' || inputs.stage != 'docs') }}"
      : "${{ needs.verify-context.outputs.build_mode == 'remote' && (github.event_name == 'push' || inputs.stage == 'all') }}",
    name: "Rust / ${{ matrix.node }}",
    needs: [independentSetup ? "release-plan" : "verify-context"],
    runsOn: ["${{ matrix.runner }}"],
    permissions: { contents: JobPermission.READ },
    env: {
      ...RUST_BUILD_ENV,
      ...(independentSetup ? { BUN_VERSION } : {}),
    },
    strategy: {
      failFast: false,
      matrix: {
        include: independentSetup
          ? ("${{ fromJSON(needs.release-plan.outputs.rust_targets) }}" as never)
          : ([...plan.targets] as never),
      },
    },
    steps: [
      ...(independentSetup ?? releaseSourceSteps()),
      ...(plan.hasPythonBindings ? [{ name: "Setup uv", uses: "astral-sh/setup-uv@v7" }] : []),
      {
        name: "Setup Rust",
        uses: `dtolnay/rust-toolchain@${plan.releaseRustVersion}`,
        with: { targets: "${{ matrix.cargo }}" },
      },
      {
        name: "Install Linux native dependencies",
        if: "${{ matrix.os == 'linux' }}",
        // prettier-ignore
        run: stringUtils.dedent(
          // ============================================================================
          /*bash*/`
            sudo rm -f /etc/apt/sources.list.d/google-chrome.list
            sudo apt-get update
            sudo apt-get install --yes libdbus-1-dev pkg-config
          `
          // ============================================================================
        ),
      },
      {
        name: "Build Rust release outputs",
        shell: "bash",
        run: timedBash("rust", rustCargoBuildCommand(plan)),
      },
      ...(bindingCommands.length
        ? [
            {
              name: "Package UniFFI outputs",
              shell: "bash",
              ...(independentSetup ? {} : { env: { VERSION: RELEASE_VERSION } }),
              run: timedBash("uniffi_packaging", bindingCommands.join("\n")),
            },
          ]
        : []),
      ...(binaryCommands.length
        ? [
            {
              name: "Package release binaries",
              shell: "bash",
              run: timedBash("binary_packaging", binaryCommands.join("\n")),
            },
          ]
        : []),
      ...rustArtifactSteps(plan),
    ],
  };
}

/** Wait for the selected local or GitHub-hosted native build source. */
export function rustAssetsJob(): Job {
  return {
    if: "${{ always() && needs.verify-context.result == 'success' && (needs.verify-context.outputs.build_mode == 'local' || needs.rust-build.result == 'success') }}",
    needs: ["verify-context", "rust-build"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.WRITE },
    steps: [
      {
        name: "Wait for locally uploaded release assets",
        if: "${{ needs.verify-context.outputs.build_mode == 'local' }}",
        env: {
          GH_TOKEN: "${{ github.token }}",
          GH_REPO: "${{ github.repository }}",
          RELEASE_TAG: RELEASE_TAG,
        },
        shell: "bash",
        run: [
          "mkdir -p dist/local-release",
          "for ATTEMPT in $(seq 1 360); do",
          '  if gh release download "$RELEASE_TAG" --pattern rust-assets.json --dir dist/local-release --clobber; then exit 0; fi',
          '  echo "waiting for local release assets ($ATTEMPT/360)"',
          "  sleep 5",
          "done",
          'echo "::error::local release assets were not uploaded"',
          "exit 1",
        ].join("\n"),
      },
      {
        name: "Confirm native release assets",
        run: "true",
      },
    ],
  };
}

export function rustCargoPublishJob(plan: RustReleasePlan, local: boolean): Job {
  const registry = local ? '"${{ vars.LOCAL_CARGO_REGISTRY }}"' : "crates-io";
  return {
    if: local
      ? "${{ github.event_name == 'push' && vars.LOCAL_REPOSITORIES == 'true' }}"
      : "${{ github.event_name == 'push' || (inputs.dry_run == false && inputs.stage == 'all') }}",
    needs: ["verify-context", ...(plan.hasTargetOutputs ? ["rust-assets"] : [])],
    runsOn: [local ? "self-hosted" : "ubuntu-latest"],
    permissions: { contents: JobPermission.READ },
    steps: [
      ...releaseSourceSteps(),
      {
        name: "Setup Rust",
        uses: `dtolnay/rust-toolchain@${plan.releaseRustVersion}`,
      },
      {
        name: local ? "Publish Cargo crates locally" : "Publish public crates",
        env: {
          CARGO_REGISTRY_TOKEN: local
            ? "${{ secrets.LOCAL_CARGO_TOKEN }}"
            : "${{ secrets.CARGO_REGISTRY_TOKEN }}",
        },
        run: plan.publicCrates
          .map((crate) => `cargo publish --package "${crate}" --registry ${registry} --no-verify`)
          .join("\n"),
      },
    ],
  };
}

export function independentRustCargoPublishJob(
  project: DBXToolsJavaScriptProject,
  plan: RustReleasePlan,
): Job {
  const commands = plan.publicCrates.map((crate) =>
    [
      `VERSION="$(jq -r --arg package "${crate}" '.rustPackages[] | select(.identity == $package) | .version' dist/release-plan.json)"`,
      'if [ -n "$VERSION" ]; then',
      `  if cargo info "${crate}@$VERSION" >/dev/null 2>&1; then`,
      `    echo "skip published ${crate}@$VERSION"`,
      "  else",
      `    cargo publish --package "${crate}" --registry crates-io --no-verify`,
      "  fi",
      "fi",
    ].join("\n"),
  );
  const buildCondition = rustBuildResultCondition(plan);
  return {
    if: plan.hasTargetOutputs
      ? `\${{ always() && needs.release-plan.outputs.rust == 'true' && ${buildCondition} && (github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'rust') }}`
      : "${{ needs.release-plan.outputs.rust == 'true' && (github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'rust') }}",
    needs: ["release-plan", ...rustBuildJobIds(plan)],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ },
    env: { BUN_VERSION },
    steps: [
      ...independentReleaseSetupSteps(project),
      {
        name: "Setup Rust",
        uses: `dtolnay/rust-toolchain@${plan.releaseRustVersion}`,
      },
      {
        name: "Publish affected Cargo crates",
        env: { CARGO_REGISTRY_TOKEN: "${{ secrets.CARGO_REGISTRY_TOKEN }}" },
        run: commands.join("\n"),
      },
    ],
  };
}

export function independentRustGitHubReleaseJob(
  project: DBXToolsJavaScriptProject,
  plan: RustReleasePlan,
): Job {
  return {
    if: "${{ needs.release-plan.outputs.github == 'true' && (github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'github') }}",
    needs: ["release-plan", ...rustBuildJobIds(plan)],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.WRITE },
    env: { BUN_VERSION },
    steps: [
      ...independentReleaseSetupSteps(project),
      {
        name: "Download release binaries",
        uses: "actions/download-artifact@v8",
        with: {
          pattern: "*-binary",
          path: "dist/rust-release",
          "merge-multiple": true,
        },
      },
      {
        name: "Upload affected GitHub release assets",
        env: { GH_TOKEN: "${{ github.token }}" },
        shell: "bash",
        run: plan.releaseBinaries
          .map((binary) => {
            const unit = defaultReleaseUnitId("rust", binary.crate);
            return [
              `VERSION="$(jq -r --arg unit "${unit}" '.units[] | select(.id == $unit) | .newVersion' dist/release-plan.json)"`,
              'if [ -n "$VERSION" ]; then',
              `  gh release upload "${unit}-v$VERSION" dist/rust-release/${binary.binary}-* --clobber`,
              "fi",
            ].join("\n");
          })
          .join("\n"),
      },
    ],
  };
}

export function rustGitHubReleaseJob(plan: RustReleasePlan): Job {
  return {
    if: "${{ github.event_name == 'push' || (inputs.dry_run == false && inputs.stage == 'all') }}",
    needs: ["verify-context", ...(plan.hasTargetOutputs ? ["rust-assets"] : [])],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.WRITE },
    steps: [
      ...releaseSourceSteps(),
      {
        name: "Download release binaries",
        if: "${{ needs.verify-context.outputs.build_mode == 'remote' }}",
        uses: "actions/download-artifact@v8",
        with: {
          pattern: "*-binary",
          path: "dist/rust-release",
          "merge-multiple": true,
        },
      },
      {
        name: "Publish GitHub release assets",
        if: "${{ needs.verify-context.outputs.build_mode == 'remote' }}",
        uses: "softprops/action-gh-release@v2",
        with: {
          files: "dist/rust-release/*",
          body_path: RELEASE_SUMMARY_FILE,
          generate_release_notes: true,
          tag_name: RELEASE_TAG,
          target_commitish: RELEASE_SHA,
        },
      },
      {
        name: "Publish locally built GitHub release",
        if: "${{ needs.verify-context.outputs.build_mode == 'local' }}",
        env: {
          GH_TOKEN: "${{ github.token }}",
          RELEASE_NOTES: RELEASE_SUMMARY_FILE,
          RELEASE_TAG,
        },
        run: 'gh release edit "$RELEASE_TAG" --draft=false --latest --notes-file "$RELEASE_NOTES"',
      },
    ],
  };
}

export function independentRustNativeNpmPublishJob(project: DBXToolsJavaScriptProject): Job {
  return {
    if: "${{ needs.release-plan.outputs.node == 'true' && (github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'node') }}",
    needs: ["release-plan", "rust-build"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ, idToken: JobPermission.WRITE },
    timeoutMinutes: 15,
    env: { BUN_VERSION, CI: "true" },
    steps: [
      ...independentReleaseSetupSteps(project),
      {
        name: "Download native npm packages",
        uses: "actions/download-artifact@v8",
        with: {
          pattern: "*-npm",
          path: "dist/uniffi/native",
          "merge-multiple": true,
        },
      },
      {
        name: "Publish affected native npm packages",
        env: npmPublishEnvironment(),
        run: "bun node_modules/@dbx-tools/projen/tasks/publish-npm.ts --directory dist/uniffi/native",
      },
    ],
  };
}

export function independentRustNodeFacadePublishJob(
  project: DBXToolsJavaScriptProject,
  bindings: readonly RustBindingMapping[],
): Job {
  return {
    if: "${{ needs.release-plan.outputs.node == 'true' && (github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'node') }}",
    needs: ["release-plan", "publish-node", "publish-native-npm"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ, idToken: JobPermission.WRITE },
    timeoutMinutes: 30,
    env: { BUN_VERSION, CI: "true" },
    steps: [
      ...independentReleaseSetupSteps(project),
      {
        name: "Build and publish affected UniFFI npm facades",
        env: npmPublishEnvironment(),
        shell: "bash",
        run: bindings
          .flatMap((binding) => {
            if (!binding.node || !binding.nodePackage) return [];
            const unit = defaultReleaseUnitId("rust", binding.crate);
            const output = `dist/uniffi/facades/${binding.crate}`;
            return [
              `VERSION="$(jq -r --arg unit "${unit}" '.units[] | select(.id == $unit) | .newVersion' dist/release-plan.json)"`,
              'if [ -n "$VERSION" ]; then',
              `  node .projen/uniffi-release.mjs facade --node "${binding.node}" --node-package "${binding.nodePackage}" --node-triple "linux-x64-gnu" --version "$VERSION" --output "${output}"`,
              `  bun node_modules/@dbx-tools/projen/tasks/publish-npm.ts --directory "${output}/npm-facade" --version "$VERSION"`,
              "fi",
            ];
          })
          .join("\n"),
      },
    ],
  };
}

export function rustNativeNpmPublishJob(project: DBXToolsJavaScriptProject): Job {
  return {
    if: "${{ always() && needs.verify-context.result == 'success' && needs.rust-assets.result == 'success' && (github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'node') }}",
    needs: ["verify-context", "rust-assets"],
    runsOn: ["ubuntu-latest"],
    permissions: {
      actions: JobPermission.READ,
      contents: JobPermission.READ,
      idToken: JobPermission.WRITE,
    },
    timeoutMinutes: 15,
    env: { BUN_VERSION, CI: "true" },
    steps: [
      ...nodeReleaseSetupSteps(project),
      ...releaseArtifactSteps({
        currentName: "Download native npm packages",
        recoveredName: "Download recovered native npm packages",
        pattern: "*-npm",
        path: "dist/uniffi/native",
        condition: "needs.verify-context.outputs.build_mode == 'remote'",
      }),
      {
        name: "Download locally built native npm packages",
        if: "${{ needs.verify-context.outputs.build_mode == 'local' }}",
        env: { GH_TOKEN: "${{ github.token }}", RELEASE_TAG },
        run: [
          "mkdir -p dist/uniffi/native",
          'gh release download "$RELEASE_TAG" --pattern "*.tgz" --dir dist/uniffi/native',
        ].join("\n"),
      },
      {
        name: "Publish native npm packages",
        env: { RELEASE_VERSION, ...npmPublishEnvironment() },
        run: 'bun node_modules/@dbx-tools/projen/tasks/publish-npm.ts --directory dist/uniffi/native --version "$RELEASE_VERSION" $DRY_RUN',
      },
    ],
  };
}

export function rustNodeFacadePublishJob(
  project: DBXToolsJavaScriptProject,
  bindings: readonly RustReleaseBinding[],
): Job {
  return {
    if: releaseStageCondition("node"),
    needs: ["verify-context", "publish-node"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ, idToken: JobPermission.WRITE },
    timeoutMinutes: 30,
    env: { BUN_VERSION, CI: "true" },
    steps: [
      ...nodeReleaseSetupSteps(project),
      {
        name: "Build and publish UniFFI npm facades",
        env: { RELEASE_VERSION, ...npmPublishEnvironment() },
        run: bindings
          .flatMap((binding) => {
            const output = `dist/uniffi/facades/${binding.crate}`;
            return [
              `node .projen/uniffi-release.mjs facade --node "${binding.node}" --node-package "${binding.nodePackage}" --node-triple "linux-x64-gnu" --version "$RELEASE_VERSION" --output "${output}"`,
              `bun node_modules/@dbx-tools/projen/tasks/publish-npm.ts --directory "${output}/npm-facade" --version "$RELEASE_VERSION" $DRY_RUN`,
            ];
          })
          .join("\n"),
      },
      {
        name: "Smoke test published UniFFI npm facades",
        if: "${{ github.event_name == 'push' && vars.UNIFFI_FACADE_SMOKE == 'true' }}",
        continueOnError: true,
        env: { RELEASE_VERSION },
        run: [
          'SMOKE_DIR="$(mktemp -d)"',
          "trap 'rm -rf \"$SMOKE_DIR\"' EXIT",
          'cd "$SMOKE_DIR"',
          "npm init --yes >/dev/null",
          ...bindings.flatMap((binding) => [
            `npm install --ignore-scripts --no-audit --no-fund --package-lock=false "${binding.nodePackage}@$RELEASE_VERSION"`,
            `node -e 'import("${binding.nodePackage}")'`,
          ]),
        ].join("\n"),
      },
    ],
  };
}
