/** Rust release planning and generated GitHub workflow jobs. */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringUtils } from "@dbx-tools/shared-core";
import { TextFile, javascript } from "projen";
import { JobPermission, type Job, type JobStep } from "projen/lib/github/workflows-model";
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

const RUST_CACHE_ENV = {
  CARGO_INCREMENTAL: "0",
  CARGO_TERM_COLOR: "always",
} as const;

function rustCacheSteps(sharedKey: string): readonly JobStep[] {
  return [
    {
      name: "Cache Cargo registry and dependencies",
      id: "cargo_cache",
      uses: "Swatinem/rust-cache@v2.9.2",
      with: {
        "cache-targets": true,
        "cache-workspace-crates": true,
        "add-job-id-key": false,
        "add-rust-environment-hash-key": true,
        "shared-key": sharedKey,
        "save-if": "${{ github.event_name == 'push' }}",
      },
    },
  ];
}

function timedBash(phase: string, command: string): string {
  return [
    "SECONDS=0",
    `trap 'status=$?; echo "phase=${phase} duration_seconds=$SECONDS status=$status"; exit "$status"' EXIT`,
    command,
  ].join("\n");
}

export function releaseBinaryAssetName(
  binaryName: string,
  nodeTarget: string,
  os: RustReleaseOs | "darwin" | "linux" | "win32",
): string {
  const extension = os === "win32" ? "zip" : "tar.gz";
  return `${binaryName}-${nodeTarget}.${extension}`;
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

interface RustReleaseBinding extends RustBindingMapping {
  readonly node: string;
  readonly python: string;
  readonly nodePackage: string;
  readonly pythonPackage: string;
}

interface RustReleaseBinaryPlan {
  readonly crate: string;
  readonly binary: string;
  readonly excludedOs: readonly RustReleaseOs[];
  readonly requiredFeatures: readonly string[];
}

interface RustReleaseTargetPlan {
  readonly runner: string;
  readonly cargo: string;
  readonly node: string;
  readonly python: string;
  readonly os: RustReleaseOs;
  readonly cpu: string;
  readonly libc: string;
  readonly packages: readonly string[];
  readonly sources: readonly string[];
  readonly binaries: readonly string[];
  readonly features: readonly string[];
  readonly fingerprintConfig: string;
}

export interface RustReleasePlan {
  readonly releaseRustVersion: string;
  readonly releaseTask: string;
  readonly releaseHelper: string;
  readonly bindings: readonly RustReleaseBinding[];
  readonly nodeBindings: readonly RustReleaseBinding[];
  readonly releaseBinaries: readonly RustReleaseBinaryPlan[];
  readonly publicCrates: readonly string[];
  readonly uniffiTargets: readonly RustReleaseTargetPlan[];
  readonly binaryTargets: readonly RustReleaseTargetPlan[];
  readonly hasPythonBindings: boolean;
  readonly usesCargoLock: boolean;
  readonly usePreinstalledWindowsRust: boolean;
  readonly hasTargetOutputs: boolean;
}

function packageClosure(
  roots: readonly RustProject[],
  packageDependencies: RustPackageDependencyResolver,
): RustProject[] {
  const found = new Set<RustProject>();
  const visit = (pkg: RustProject): void => {
    if (found.has(pkg)) return;
    found.add(pkg);
    for (const dependency of packageDependencies(pkg)) visit(dependency);
  };
  for (const pkg of roots) visit(pkg);
  return [...found].sort((left, right) => left.crateName.localeCompare(right.crateName));
}

function packageSources(
  project: javascript.NodeProject,
  packages: readonly RustProject[],
): string[] {
  return packages.map((pkg) => relative(project.outdir, pkg.outdir).replaceAll("\\", "/")).sort();
}

function releaseTargetPlan(
  target: UniFFIReleaseTarget,
  packages: readonly RustProject[],
  sources: readonly string[],
  binaries: readonly string[],
  features: readonly string[],
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
    packages: packageNames,
    sources,
    binaries: sortedBinaries,
    features: sortedFeatures,
    fingerprintConfig: JSON.stringify({
      packages: packageNames,
      binaries: sortedBinaries,
      features: sortedFeatures,
    }),
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
  const bindingClosure = packageClosure(bindingPackages, packageDependencies);
  const bindingSources = packageSources(project, bindingClosure);
  const uniffiTargets = bindings.length
    ? targets.map((target) =>
        releaseTargetPlan(
          target,
          bindingPackages,
          bindingSources,
          [],
          bindingPackages.map((pkg) => `${pkg.crateName}/${UNIFFI_BINDGEN_FEATURE}`),
        ),
      )
    : [];
  const binaryTargets = targets.flatMap((target) => {
    const selectedBinaries = releaseBinaries.filter(
      (binary) => !binary.excludedOs.includes(target.os),
    );
    const binaryPackages = packages.filter((pkg) =>
      selectedBinaries.some((binary) => binary.crate === pkg.crateName),
    );
    if (!binaryPackages.length) return [];
    const binaryClosure = packageClosure(binaryPackages, packageDependencies);
    const features = selectedBinaries.flatMap((binary) =>
      binary.requiredFeatures.map((feature) => `${binary.crate}/${feature}`),
    );
    return [
      releaseTargetPlan(
        target,
        binaryPackages,
        packageSources(project, binaryClosure),
        selectedBinaries.map((binary) => binary.binary),
        features,
      ),
    ];
  });
  const hasTargetOutputs = uniffiTargets.length > 0 || binaryTargets.length > 0;
  if (hasTargetOutputs && targets.length === 0) {
    throw new Error("Rust release requires at least one target");
  }
  return {
    releaseRustVersion,
    releaseTask: ".projen/uniffi-release.mjs",
    releaseHelper: ".projen/rust-release.mjs",
    bindings,
    nodeBindings: bindings.filter((binding) => Boolean(binding.node && binding.nodePackage)),
    releaseBinaries,
    publicCrates,
    uniffiTargets,
    binaryTargets,
    hasPythonBindings: bindings.some((binding) => binding.python),
    usesCargoLock: existsSync(join(project.outdir, "Cargo.lock")),
    usePreinstalledWindowsRust: releaseRustVersion === "stable",
    hasTargetOutputs,
  };
}

function rustBuildJobIds(plan: RustReleasePlan): string[] {
  return [
    ...(plan.uniffiTargets.length ? ["rust-uniffi"] : []),
    ...(plan.binaryTargets.length ? ["rust-binaries"] : []),
  ];
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
  const bindingSupportFiles = [
    plan.releaseTask,
    ".projen/uniffi-python.js",
    ".projen/smol-toml.cjs",
    ".projen/smol-toml.LICENSE",
  ] as const;
  new TextFile(project, plan.releaseHelper, {
    lines: taskSource("rust-release.mjs").trimEnd().split("\n"),
  });
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
  const fingerprintTask = project.addTask("rs:release-fingerprint", {
    description: "Write the version-independent Rust release build manifest",
  });
  for (const [namespace, targets] of [
    ["uniffi", plan.uniffiTargets],
    ["binaries", plan.binaryTargets],
  ] as const) {
    if (!targets.length) continue;
    const sources = [...new Set(targets.flatMap((target) => target.sources))].sort();
    fingerprintTask.exec(
      [
        `node ${plan.releaseHelper} fingerprint`,
        "--root .",
        `--output ${JSON.stringify(`.release/rust-${namespace}.json`)}`,
        `--namespace ${JSON.stringify(namespace)}`,
        ...targets.map(
          (target) => `--target ${JSON.stringify(`${target.cargo}|${target.fingerprintConfig}`)}`,
        ),
        `--toolchain ${JSON.stringify(plan.releaseRustVersion)}`,
        ...sources.map((source) => `--source ${JSON.stringify(source)}`),
        "--source-only",
        "--portable",
      ].join(" "),
    );
  }
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

type RustBuildKind = "uniffi" | "binaries";

function rustArtifactSteps(plan: RustReleasePlan, kind: RustBuildKind): JobStep[] {
  const binaryCrates = [...new Set(plan.releaseBinaries.map((binary) => binary.crate))];
  return [
    ...(kind === "uniffi"
      ? plan.bindings.flatMap((binding) => [
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
        ])
      : []),
    ...(kind === "binaries" ? binaryCrates : []).map((crate) => {
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

function rustCargoBuildCommand(plan: RustReleasePlan, kind: RustBuildKind): string {
  return [
    "PACKAGE_ARGS=()",
    "FEATURE_ARGS=()",
    matrixArgumentLoop("PACKAGE", "packages", "--package"),
    matrixArgumentLoop("FEATURE", "features", "--features"),
    ...(kind === "binaries"
      ? ["BINARY_ARGS=()", matrixArgumentLoop("BINARY", "binaries", "--bin")]
      : ["BINARY_ARGS=()"]),
    `cargo build --release --timings "\${PACKAGE_ARGS[@]}" "\${BINARY_ARGS[@]}" "\${FEATURE_ARGS[@]}"${
      plan.usesCargoLock ? " --locked" : ""
    } --target "\${{ matrix.cargo }}"`,
  ].join("\n");
}

export function rustBuildJob(
  plan: RustReleasePlan,
  kind: RustBuildKind,
  independentSetup?: readonly JobStep[],
): Job {
  const independent = Boolean(independentSetup);
  const targets = kind === "uniffi" ? plan.uniffiTargets : plan.binaryTargets;
  const outputName = kind === "uniffi" ? "rust_uniffi_targets" : "rust_binary_targets";
  const title = kind === "uniffi" ? "UniFFI" : "binaries";
  const bindingCommands = kind === "uniffi" ? rustBindingCommands(plan, independent) : [];
  const binaryCommands = kind === "binaries" ? rustBinaryCommands(plan, independent) : [];
  const fingerprintSources = [...new Set(targets.flatMap((target) => target.sources))].sort();
  return {
    if: independentSetup
      ? `\${{ needs.release-plan.outputs.${outputName} != '[]' && (github.event_name == 'push' || inputs.stage != 'docs') }}`
      : "${{ github.event_name == 'push' || inputs.stage == 'all' }}",
    name: `${title} / \${{ matrix.node }}`,
    needs: [independentSetup ? "release-plan" : "verify-context"],
    runsOn: ["${{ matrix.runner }}"],
    permissions: { contents: JobPermission.READ },
    env: {
      ...RUST_CACHE_ENV,
      ...(independentSetup ? { BUN_VERSION } : {}),
    },
    strategy: {
      failFast: false,
      matrix: {
        include: independentSetup
          ? (`\${{ fromJSON(needs.release-plan.outputs.${outputName}) }}` as never)
          : ([...targets] as never),
      },
    },
    steps: [
      ...(independentSetup ?? releaseSourceSteps()),
      ...(kind === "uniffi" && plan.hasPythonBindings
        ? [{ name: "Setup uv", uses: "astral-sh/setup-uv@v7" }]
        : []),
      {
        name: "Setup Rust",
        ...(plan.usePreinstalledWindowsRust ? { if: "${{ matrix.os != 'win32' }}" } : {}),
        uses: `dtolnay/rust-toolchain@${plan.releaseRustVersion}`,
        with: { targets: "${{ matrix.cargo }}" },
      },
      ...(plan.usePreinstalledWindowsRust
        ? [
            {
              name: "Verify preinstalled Windows Rust",
              if: "${{ matrix.os == 'win32' }}",
              shell: "bash",
              run: [
                "rustc --version --verbose",
                "cargo --version",
                'rustup target list --installed | grep -Fx "${{ matrix.cargo }}"',
                'test -f "$(rustc --print sysroot)/lib/rustlib/${{ matrix.cargo }}/bin/rust-lld.exe"',
              ].join("\n"),
            },
          ]
        : []),
      {
        name: "Install LLVM release tools",
        shell: "bash",
        run: "rustup component add llvm-tools-preview",
      },
      ...rustCacheSteps(`release-${kind}-\${{ matrix.cargo }}-rust-${plan.releaseRustVersion}`),
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
        name: "Verify Rust build fingerprint",
        if: independentSetup
          ? undefined
          : "${{ github.event_name == 'push' || inputs.stage == 'all' }}",
        ...(!independentSetup ? { id: "rust-fingerprint" } : {}),
        shell: "bash",
        run: [
          `RUNTIME_MANIFEST="dist/rust-raw/rust-${kind}-build-\${{ matrix.node }}.json"`,
          'mkdir -p "$(dirname "$RUNTIME_MANIFEST")"',
          [
            `node ${plan.releaseHelper} fingerprint --root .`,
            '--output "$RUNTIME_MANIFEST"',
            `--namespace ${JSON.stringify(kind)}`,
            '--target "${{ matrix.cargo }}|${{ matrix.fingerprintConfig }}"',
            `--toolchain ${JSON.stringify(plan.releaseRustVersion)}`,
            ...fingerprintSources.map((source) => `--source ${JSON.stringify(source)}`),
            "--source-only",
            ...(independentSetup ? ["--portable"] : []),
          ].join(" "),
          `test "$(jq -r .namespace "$RUNTIME_MANIFEST")" = "$(jq -r .namespace .release/rust-${kind}.json)"`,
          `test "$(jq -r .rustSourceHash "$RUNTIME_MANIFEST")" = "$(jq -r .rustSourceHash .release/rust-${kind}.json)"`,
          'KEY="$(jq -r --arg target "${{ matrix.cargo }}" \'.targets[$target] // empty\' "$RUNTIME_MANIFEST")"',
          'test -n "$KEY"',
          'echo "key=$KEY" >> "$GITHUB_OUTPUT"',
        ].join("\n"),
      },
      ...(!independentSetup
        ? [
            {
              name: "Reuse matching raw Rust outputs",
              id: "raw-native",
              shell: "bash",
              env: { GH_TOKEN: "${{ github.token }}" },
              // prettier-ignore
              run: stringUtils.dedent(
                // ============================================================================
                /*bash*/`
                KEY="\${{ steps.rust-fingerprint.outputs.key }}"
                test -n "$KEY"
                ASSET="rust-${kind}-raw-\${{ matrix.node }}-$KEY.tar.gz"
                mkdir -p dist/rust-raw
                MATCH="$(gh api --paginate "repos/\${{ github.repository }}/releases?per_page=100" --jq '.[] | select(.draft == false) | . as $release | .assets[] | select(.name == "'"$ASSET"'") | [$release.tag_name, .url] | @tsv' | head -n 1)"
                if [ -n "$MATCH" ]; then
                  TAG="\${MATCH%%$'\\t'*}"
                  URL="\${MATCH#*$'\\t'}"
                  CHECKSUM_URL="$(gh api "repos/\${{ github.repository }}/releases/tags/$TAG" --jq '.assets[] | select(.name == "'"$ASSET.sha256"'") | .url')"
                  rm -rf "target/\${{ matrix.cargo }}/release"
                  if test -n "$CHECKSUM_URL" && gh api "$URL" -H "Accept: application/octet-stream" > "dist/rust-raw/$ASSET" && gh api "$CHECKSUM_URL" -H "Accept: application/octet-stream" > "dist/rust-raw/$ASSET.sha256" && (cd dist/rust-raw && if command -v sha256sum >/dev/null 2>&1; then sha256sum --check "$ASSET.sha256"; else shasum -a 256 --check "$ASSET.sha256"; fi) && tar -xzf "dist/rust-raw/$ASSET"; then
                    echo "hit=true" >> "$GITHUB_OUTPUT"
                  else
                    rm -rf "target/\${{ matrix.cargo }}/release" "dist/rust-raw/$ASSET" "dist/rust-raw/$ASSET.sha256"
                    echo "::warning::matching raw Rust bundle failed validation; rebuilding"
                    echo "hit=false" >> "$GITHUB_OUTPUT"
                  fi
                else
                  echo "hit=false" >> "$GITHUB_OUTPUT"
                fi
                echo "asset=$ASSET" >> "$GITHUB_OUTPUT"
              `
                // ============================================================================
              ),
            },
          ]
        : []),
      {
        name: `Build Rust ${title} outputs`,
        ...(independentSetup ? {} : { if: "${{ steps.raw-native.outputs.hit != 'true' }}" }),
        shell: "bash",
        env: {
          CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER:
            "${{ matrix.os == 'win32' && 'rust-lld' || '' }}",
        },
        run: timedBash(`rust_${kind}`, rustCargoBuildCommand(plan, kind)),
      },
      ...(!independentSetup
        ? [
            {
              name: "Upload Cargo timings",
              if: "${{ steps.raw-native.outputs.hit != 'true' }}",
              uses: "actions/upload-artifact@v7",
              with: {
                name: `rust-${kind}-\${{ matrix.node }}-cargo-timings`,
                path: "target/cargo-timings/*",
                "retention-days": 14,
              },
            },
          ]
        : []),
      ...(!independentSetup
        ? [
            {
              name: "Archive raw Rust outputs",
              if: "${{ steps.raw-native.outputs.hit != 'true' }}",
              shell: "bash",
              run: [
                "mkdir -p dist/rust-raw",
                'tar -czf "dist/rust-raw/${{ steps.raw-native.outputs.asset }}" "target/${{ matrix.cargo }}/release"',
                '(cd dist/rust-raw && if command -v sha256sum >/dev/null 2>&1; then sha256sum "${{ steps.raw-native.outputs.asset }}"; else shasum -a 256 "${{ steps.raw-native.outputs.asset }}"; fi > "${{ steps.raw-native.outputs.asset }}.sha256")',
              ].join("\n"),
            },
            {
              name: "Stamp native release version",
              shell: "bash",
              env: { VERSION: RELEASE_VERSION },
              run: `node ${plan.releaseHelper} stamp-tree --root "target/\${{ matrix.cargo }}/release" --version "$VERSION"`,
            },
          ]
        : []),
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
      ...(!independentSetup
        ? [
            {
              name: "Upload reusable raw Rust outputs",
              uses: "actions/upload-artifact@v7",
              with: {
                name: `rust-${kind}-\${{ matrix.node }}-raw`,
                path: "dist/rust-raw/*",
                "retention-days": 7,
              },
            },
          ]
        : []),
      ...rustArtifactSteps(plan, kind),
    ],
  };
}

export function rustCargoPublishJob(plan: RustReleasePlan, local: boolean): Job {
  const registry = local ? '"${{ vars.LOCAL_CARGO_REGISTRY }}"' : "crates-io";
  return {
    if: local
      ? "${{ github.event_name == 'push' && vars.LOCAL_REPOSITORIES == 'true' }}"
      : "${{ github.event_name == 'push' }}",
    needs: ["verify-context", ...rustBuildJobIds(plan)],
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
        name: "Download reusable raw Rust outputs",
        uses: "actions/download-artifact@v8",
        with: {
          pattern: "*-raw",
          path: "dist/rust-raw",
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
    if: "${{ github.event_name == 'push' }}",
    needs: ["verify-context", ...rustBuildJobIds(plan)],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.WRITE },
    steps: [
      ...releaseSourceSteps(),
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
        name: "Download reusable raw Rust outputs",
        uses: "actions/download-artifact@v8",
        with: {
          pattern: "*-raw",
          path: "dist/rust-raw",
          "merge-multiple": true,
        },
      },
      {
        name: "Publish GitHub release assets",
        uses: "softprops/action-gh-release@v2",
        with: {
          files: ["dist/rust-release/*", "dist/rust-raw/*"].join("\n"),
          body_path: RELEASE_SUMMARY_FILE,
          generate_release_notes: true,
          tag_name: RELEASE_TAG,
          target_commitish: RELEASE_SHA,
        },
      },
      {
        name: "Delete superseded raw Rust release assets",
        uses: "actions/github-script@v8",
        env: { CURRENT_RELEASE_TAG: RELEASE_TAG },
        with: {
          // prettier-ignore
          script: stringUtils.dedent(
            // ============================================================================
            /*js*/`
            const currentTag = process.env.CURRENT_RELEASE_TAG;
            if (!currentTag) throw new Error("CURRENT_RELEASE_TAG is required");
            const parseVersion = (tag) => {
              const match = /^v(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(tag);
              return match ? match.slice(1).map(Number) : undefined;
            };
            const compareVersions = (left, right) => {
              for (let index = 0; index < 3; index += 1) {
                if (left[index] !== right[index]) return left[index] - right[index];
              }
              return 0;
            };
            const currentVersion = parseVersion(currentTag);
            if (!currentVersion) throw new Error(\`Unsupported release tag: \${currentTag}\`);
            const releases = await github.paginate(github.rest.repos.listReleases, {
              ...context.repo,
              per_page: 100,
            });
            const assets = releases.flatMap((release) => {
              const version = parseVersion(release.tag_name);
              if (release.draft || !version || compareVersions(version, currentVersion) >= 0) {
                return [];
              }
              return release.assets.filter((asset) =>
                /^rust-(?:(?:uniffi|binaries)-(?:raw|build)|(?:raw|build))-/.test(asset.name)
              );
            });
            for (const asset of assets) {
              core.info(\`Deleting \${asset.name} (\${asset.id})\`);
              await github.rest.repos.deleteReleaseAsset({
                ...context.repo,
                asset_id: asset.id,
              });
            }
            core.info(\`Deleted \${assets.length} superseded raw Rust release assets\`);
          `
            // ============================================================================
          ),
        },
      },
    ],
  };
}

export function independentRustNativeNpmPublishJob(project: DBXToolsJavaScriptProject): Job {
  return {
    if: "${{ needs.release-plan.outputs.node == 'true' && (github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'node') }}",
    needs: ["release-plan", "rust-uniffi"],
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
    if: "${{ always() && needs.verify-context.result == 'success' && needs.rust-uniffi.result != 'failure' && needs.rust-uniffi.result != 'cancelled' && (github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'node') }}",
    needs: ["verify-context", "rust-uniffi"],
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
      }),
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
