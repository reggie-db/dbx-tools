/**
 * OpenAPI generator for tsoa controllers and code-first Rust producers.
 *
 * TypeScript packages are discovered from tsoa imports. Rust producers are
 * recorded by `DBXToolsRustWorkspace`. Both feed the same optimized generated
 * package:
 *
 *   - `openapi.json`   - the OpenAPI 3 spec (tsoa `generateSpec`, then Speakeasy
 *     optimization to extract duplicate inline schemas into components).
 *   - `src/schema.ts`  - types generated from the spec (openapi-typescript).
 *   - `src/client.ts`  - a typed `openapi-fetch` client, usable client-side.
 *
 * `generateSpec` then reads the actual controller decorators + TypeScript types from
 * those files, so the API surface is annotated on the methods and nothing is
 * hand-written twice. The generated client stack is openapi-typescript +
 * openapi-fetch (openapi-ts.dev), the best-of-2026 choice since AppKit ships no
 * OpenAPI client generator.
 *
 * `tsoa`, `typescript`, and `openapi-typescript` are loaded lazily (heavy, and only
 * needed for `bun run openapi`), so importing this module stays cheap. `tsoa` and
 * `typescript` are not engine dependencies at all - both are resolved out of the
 * consuming workspace, which is where they already live. Speakeasy's `openapi`
 * binary is installed lazily through `@dbx-tools/core`'s binary cache.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import * as bin from "@dbx-tools/core/bin";
import { find } from "@dbx-tools/path";
import { log, object, stringUtils } from "@dbx-tools/shared-core";
import type * as ts from "typescript";
import { lazyRequire } from "./_lazy-require.ts";
import { makeReadonly, makeWritable, stampGenerated } from "./generated.ts";
import {
  type RecordedPackage,
  isModuleFile,
  repoRoot,
  toPosix,
  recordedPackages,
} from "./packages.ts";
import type { RustOpenApiMapping, RustWorkspaceMapping } from "./project-rs.ts";
import type { ReleaseUnitGraph } from "./release-catalog.ts";
import { readWorkspaceVersion } from "./workspace-version.ts";

const logger = log.logger("projen:openapi");

/** The tag (and folder) the generated openapi client packages are written under. */
const OPENAPI_TAG = "openapi";
/** Heuristic: a module file whose source imports tsoa's runtime package. */
const TSOA_IMPORT = /from\s+['"](?:tsoa|@tsoa\/runtime)['"]/;
const SPEAKEASY_OPENAPI_VERSION = "1.24.0";
const SPEAKEASY_OPENAPI_RELEASE_URL = `https://github.com/speakeasy-api/openapi/releases/download/v${SPEAKEASY_OPENAPI_VERSION}`;
const execFileAsync = promisify(execFile);

// prettier-ignore
const CLIENT_SRC =
  stringUtils.dedent(
    // ============================================================================
    /*ts*/`
    import createClient, { type ClientOptions } from "openapi-fetch";
    import type { paths } from "./schema";

    /** Create a typed OpenAPI client (openapi-fetch); safe to use in the browser. */
    export function createApiClient(options?: ClientOptions) {
      return createClient<paths>(options);
    }
    `
    // ============================================================================
  ) + "\n";

/** True if any module file in `<pkg>/src` matches {@link TSOA_IMPORT}. */
function hasTsoaControllers(pkg: Pick<RecordedPackage, "dir">): boolean {
  const srcDir = tsoaSource(pkg);
  return object
    .sequence(find.findFiles("**/*", { cwd: srcDir }))
    .filter(isModuleFile)
    .some((file) => TSOA_IMPORT.test(readFileSync(join(srcDir, file), "utf8")));
}

function tsoaSource(pkg: Pick<RecordedPackage, "dir">): string {
  return join(pkg.dir, "src");
}

function isTsoaCandidate(pkg: RecordedPackage): boolean {
  return pkg.tags.includes("server") || pkg.tags.includes("node");
}

/** `server`/`node` packages (never the generated `openapi` tag) with a tsoa import. */
function controllerPackages(): object.Sequence<RecordedPackage> {
  return object.sequence(recordedPackages()).filter(isTsoaCandidate).filter(hasTsoaControllers);
}

function rustOpenapiMappings(): RustOpenApiMapping[] {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as unknown;
  if (!object.isRecord(manifest)) return [];
  const config = manifest.dbxToolsConfig;
  if (!object.isRecord(config) || !object.isRecord(config.rust)) return [];
  const mapping = config.rust as unknown as Partial<RustWorkspaceMapping>;
  return Array.isArray(mapping.openapi) ? [...mapping.openapi] : [];
}

function inside(path: string, directory: string): boolean {
  const child = relative(resolve(directory), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

/** Whether one changed source belongs to any producing package directory. */
export function isOpenapiProducerSource(path: string, producers: readonly string[]): boolean {
  const absolute = resolve(path);
  return object.sequence(producers).some((producer) => inside(absolute, producer));
}

function rustOpenapiSources(mapping: RustOpenApiMapping): string[] {
  return [resolve(repoRoot, mapping.rust, "src"), resolve(repoRoot, mapping.rust, "Cargo.toml")];
}

/** Source roots consumed by TypeScript and Rust OpenAPI producers. */
export function openapiWatchRoots(): string[] {
  return [
    ...controllerPackages()
      .map((pkg) => resolve(tsoaSource(pkg)))
      .join(object.sequence(rustOpenapiMappings()).flatMap(rustOpenapiSources))
      .distinct(),
  ];
}

/** Whether one changed source belongs to an OpenAPI-producing package. */
export function isOpenapiSource(path: string): boolean {
  const absolute = resolve(path);
  const segments = toPosix(relative(repoRoot, absolute)).split("/");
  if (segments.includes(OPENAPI_TAG)) return false;
  if (
    object
      .sequence(rustOpenapiMappings())
      .flatMap(rustOpenapiSources)
      .some((source) => inside(absolute, source))
  ) {
    return true;
  }
  return object
    .sequence(recordedPackages())
    .filter(isTsoaCandidate)
    .filter((pkg) => inside(absolute, tsoaSource(pkg)))
    .some(hasTsoaControllers);
}

/** GitHub release asset name for Speakeasy's OpenAPI binary. */
export function speakeasyOpenapiAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const osName =
    platform === "darwin"
      ? "Darwin"
      : platform === "linux"
        ? "Linux"
        : platform === "win32"
          ? "Windows"
          : undefined;
  const archName = arch === "arm64" ? "arm64" : arch === "x64" ? "x86_64" : undefined;
  if (!osName || !archName) {
    throw new Error(`Speakeasy openapi has no supported release asset for ${platform}/${arch}`);
  }
  const extension = platform === "win32" ? "zip" : "tar.gz";
  return `openapi_${osName}_${archName}.${extension}`;
}

async function speakeasyOpenapiPath(): Promise<string> {
  const assetName = speakeasyOpenapiAssetName();
  const context = await bin.ensure("openapi", `${SPEAKEASY_OPENAPI_RELEASE_URL}/${assetName}`, {
    autoUnpackage: true,
    minVersion: SPEAKEASY_OPENAPI_VERSION,
    selector: ({ source }) =>
      join(source, process.platform === "win32" ? "openapi.exe" : "openapi"),
    versionParser: (output) => {
      const version = bin.parseVersion(output);
      return version === SPEAKEASY_OPENAPI_VERSION ? version : undefined;
    },
  });
  return context.path;
}

/** Deduplicate inline schemas into `components.schemas` with Speakeasy. */
export async function optimizeOpenapiSpec(specPath: string, executable?: string): Promise<void> {
  const openapi = executable ?? (await speakeasyOpenapiPath());
  await execFileAsync(openapi, ["spec", "optimize", specPath, "--write", "--non-interactive"]);
}

/** Cargo arguments that export one Rust producer's aide document. */
export function rustOpenapiArgs(
  mapping: RustOpenApiMapping,
  output: string,
  targetDir = join(repoRoot, "target/openapi"),
): string[] {
  return [
    "run",
    "--quiet",
    "--target-dir",
    targetDir,
    "--package",
    mapping.crate,
    ...(mapping.noDefaultFeatures ? ["--no-default-features"] : []),
    ...(mapping.features.length ? ["--features", mapping.features.join(",")] : []),
    ...(mapping.binary ? ["--bin", mapping.binary] : []),
    "--",
    "--generate-spec",
    output,
  ];
}

type OpenApiTypeTools = {
  openapiTS: typeof import("openapi-typescript").default;
  astToString: typeof import("openapi-typescript").astToString;
};

async function writeClientPackage(
  outDir: string,
  source: string,
  tools: OpenApiTypeTools,
): Promise<void> {
  const srcDir = join(outDir, "src");
  mkdirSync(srcDir, { recursive: true });
  const specPath = join(outDir, "openapi.json");
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const schemaPath = join(srcDir, "schema.ts");
  makeWritable(schemaPath);
  writeFileSync(schemaPath, tools.astToString(await tools.openapiTS(spec)));
  stampGenerated(schemaPath, {
    tool: "projen openapi (Speakeasy + openapi-typescript)",
    source,
  });

  const clientPath = join(srcDir, "client.ts");
  makeWritable(clientPath);
  writeFileSync(clientPath, CLIENT_SRC);
  stampGenerated(clientPath, {
    tool: "projen openapi (openapi-fetch)",
    source: "./schema",
  });
}

/**
 * Regenerate the `openapi` packages from every server/node package with a tsoa
 * import. Returns the package dirs it wrote so the caller can rebuild their barrels.
 * A separate projen synth is still needed before new openapi folders become workspace
 * members in `pnpm-workspace.yaml`.
 */
export async function generateOpenapi(): Promise<string[]> {
  const pkgs = controllerPackages().toArray();
  const rustMappings = rustOpenapiMappings();
  // Same reasoning as codegen's empty case: a workspace with no tsoa controllers
  // is not a condition worth a line on every synth.
  if (pkgs.length === 0 && rustMappings.length === 0) {
    logger.debug("no TypeScript or Rust OpenAPI producers found");
    return [];
  }

  // Lazy, resilient loads: tsoa + typescript are CJS (require), openapi-typescript
  // is ESM (dynamic import).
  const { default: openapiTS, astToString } = await import("openapi-typescript");
  const tools = { openapiTS, astToString };

  const typescript =
    pkgs.length > 0
      ? (() => {
          const require = createRequire(import.meta.url);
          const { generateSpec } = lazyRequire<typeof import("tsoa")>(
            require,
            "tsoa",
            "openapi generation",
          );
          const runtime = lazyRequire<typeof ts>(require, "typescript", "openapi generation");
          return {
            generateSpec,
            compilerOptions: {
              experimentalDecorators: true,
              target: runtime.ScriptTarget.ES2022,
              module: runtime.ModuleKind.ESNext,
              moduleResolution: runtime.ModuleResolutionKind.Bundler,
              esModuleInterop: true,
              skipLibCheck: true,
            } satisfies ts.CompilerOptions,
          };
        })()
      : undefined;

  const releaseGraphPath = join(repoRoot, ".projen/release-units.json");
  const releaseGraph = existsSync(releaseGraphPath)
    ? (JSON.parse(readFileSync(releaseGraphPath, "utf8")) as ReleaseUnitGraph)
    : undefined;
  const written: string[] = [];
  for (const p of pkgs) {
    const releaseProject = releaseGraph?.projects.find((project) => project.path === p.path);
    const specVersion =
      releaseGraph?.units.find((unit) => unit.id === releaseProject?.unit)?.version ??
      readWorkspaceVersion(repoRoot);
    // The generated package's folder is the source's leaf folder name (`api`), not
    // its npm name - `p.name` is the (possibly-overridden) manifest name.
    const leaf = p.relPath.split("/").pop() ?? p.relPath;
    const outDir = join(repoRoot, p.root, OPENAPI_TAG, leaf);
    mkdirSync(outDir, { recursive: true });

    // 1) tsoa writes a temporary openapi.json, Speakeasy optimizes it there, then
    // the complete spec moves into place so readers never observe an intermediate file.
    const specPath = join(outDir, "openapi.json");
    const tempDir = mkdtempSync(join(outDir, ".openapi-"));
    const tempSpecPath = join(tempDir, "openapi.json");
    try {
      await typescript!.generateSpec(
        {
          entryFile: "",
          noImplicitAdditionalProperties: "throw-on-extras",
          controllerPathGlobs: [join(p.dir, "src/**/*.ts")],
          outputDirectory: tempDir,
          specFileBaseName: "openapi",
          specVersion: 3,
          name: `${p.relPath} API`,
          version: specVersion,
        },
        typescript!.compilerOptions,
      );
      await optimizeOpenapiSpec(tempSpecPath);
      makeWritable(specPath);
      renameSync(tempSpecPath, specPath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
    makeReadonly(specPath);
    await writeClientPackage(outDir, `the tsoa controllers in ${p.relPath}`, tools);

    written.push(outDir);
    logger.success(`openapi/${leaf} (from ${p.relPath})`);
  }
  for (const mapping of rustMappings) {
    const outDir = resolve(repoRoot, mapping.output);
    mkdirSync(outDir, { recursive: true });
    const specPath = join(outDir, "openapi.json");
    const tempDir = mkdtempSync(join(outDir, ".openapi-"));
    const tempSpecPath = join(tempDir, "openapi.json");
    try {
      await execFileAsync("cargo", rustOpenapiArgs(mapping, tempSpecPath), { cwd: repoRoot });
      await optimizeOpenapiSpec(tempSpecPath);
      makeWritable(specPath);
      renameSync(tempSpecPath, specPath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
    makeReadonly(specPath);
    await writeClientPackage(outDir, `the aide routes in ${mapping.rust}`, tools);
    written.push(outDir);
    logger.success(`${mapping.output} (from ${mapping.rust})`);
  }
  return written;
}
