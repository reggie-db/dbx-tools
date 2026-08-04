/**
 * OpenAPI generator (tsoa-based).
 *
 * Scans `server`/`node` packages for modules that **import tsoa**
 * (`from 'tsoa'` / `from '@tsoa/runtime'`) and, for each package that has them,
 * generates a read-only `<root>/openapi/<name>` package:
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
import { join } from "node:path";
import { promisify } from "node:util";
import { bin } from "@dbx-tools/core";
import { find } from "@dbx-tools/path";
import { log } from "@dbx-tools/shared-core";
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

const logger = log.logger("projen:openapi");

/** The tag (and folder) the generated openapi client packages are written under. */
const OPENAPI_TAG = "openapi";
/** Heuristic: a module file whose source imports tsoa's runtime package. */
const TSOA_IMPORT = /from\s+['"](?:tsoa|@tsoa\/runtime)['"]/;
const SPEAKEASY_OPENAPI_VERSION = "1.24.0";
const SPEAKEASY_OPENAPI_RELEASE_URL = `https://github.com/speakeasy-api/openapi/releases/download/v${SPEAKEASY_OPENAPI_VERSION}`;
const execFileAsync = promisify(execFile);

const CLIENT_SRC = `import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema";

/** Create a typed OpenAPI client (openapi-fetch); safe to use in the browser. */
export function createApiClient(options?: ClientOptions) {
  return createClient<paths>(options);
}
`;

/** True if any module file in `<pkg>/src` matches {@link TSOA_IMPORT}. */
function hasTsoaControllers(pkg: Pick<RecordedPackage, "dir">): boolean {
  const srcDir = join(pkg.dir, "src");
  return [...find.findFiles("**/*", { cwd: srcDir })]
    .filter(isModuleFile)
    .some((f) => TSOA_IMPORT.test(readFileSync(join(srcDir, f), "utf8")));
}

/** `server`/`node` packages (never the generated `openapi` tag) with a tsoa import. */
function controllerPackages(): RecordedPackage[] {
  return recordedPackages().filter(
    (p) => (p.tags.includes("server") || p.tags.includes("node")) && hasTsoaControllers(p),
  );
}

/** True if the changed path is a source file that matches {@link TSOA_IMPORT}. */
export function isTsoaController(path: string): boolean {
  const posix = toPosix(path);
  return (
    !posix.includes(`/${OPENAPI_TAG}/`) &&
    isModuleFile(path) &&
    existsSync(path) &&
    TSOA_IMPORT.test(readFileSync(path, "utf8"))
  );
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

/**
 * Regenerate the `openapi` packages from every server/node package with a tsoa
 * import. Returns the package dirs it wrote so the caller can rebuild their barrels.
 * A separate projen synth is still needed before new openapi folders become workspace
 * members in `pnpm-workspace.yaml`.
 */
export async function generateOpenapi(): Promise<string[]> {
  const pkgs = controllerPackages();
  // Same reasoning as codegen's empty case: a workspace with no tsoa controllers
  // is not a condition worth a line on every synth.
  if (pkgs.length === 0) {
    logger.debug("no tsoa controllers found in any server/node package");
    return [];
  }

  // Lazy, resilient loads: tsoa + typescript are CJS (require), openapi-typescript
  // is ESM (dynamic import).
  const require = createRequire(import.meta.url);
  const { generateSpec } = lazyRequire<typeof import("tsoa")>(
    require,
    "tsoa",
    "openapi generation",
  );
  const tsRuntime = lazyRequire<typeof ts>(require, "typescript", "openapi generation");
  const { default: openapiTS, astToString } = await import("openapi-typescript");

  // Read tsoa's controllers with decorator support; skipLibCheck keeps third-party
  // `.d.ts` out of the spec-generation compile.
  const compilerOptions: ts.CompilerOptions = {
    experimentalDecorators: true,
    target: tsRuntime.ScriptTarget.ES2022,
    module: tsRuntime.ModuleKind.ESNext,
    moduleResolution: tsRuntime.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    skipLibCheck: true,
  };

  const written: string[] = [];
  for (const p of pkgs) {
    // The generated package's folder is the source's leaf folder name (`api`), not
    // its npm name - `p.name` is the (possibly-overridden) manifest name.
    const leaf = p.relPath.split("/").pop() ?? p.relPath;
    const outDir = join(repoRoot, p.root, OPENAPI_TAG, leaf);
    const srcDir = join(outDir, "src");
    mkdirSync(srcDir, { recursive: true });

    // 1) tsoa writes a temporary openapi.json, Speakeasy optimizes it there, then
    // the complete spec moves into place so readers never observe an intermediate file.
    const specPath = join(outDir, "openapi.json");
    const tempDir = mkdtempSync(join(outDir, ".openapi-"));
    const tempSpecPath = join(tempDir, "openapi.json");
    try {
      await generateSpec(
        {
          entryFile: "",
          noImplicitAdditionalProperties: "throw-on-extras",
          controllerPathGlobs: [join(p.dir, "src/**/*.ts")],
          outputDirectory: tempDir,
          specFileBaseName: "openapi",
          specVersion: 3,
          name: `${p.relPath} API`,
          version: "0.0.0",
        },
        compilerOptions,
      );
      await optimizeOpenapiSpec(tempSpecPath);
      makeWritable(specPath);
      renameSync(tempSpecPath, specPath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
    makeReadonly(specPath);

    // 2) src/schema.ts: types generated from the spec (openapi-typescript).
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    const schemaPath = join(srcDir, "schema.ts");
    makeWritable(schemaPath);
    writeFileSync(schemaPath, astToString(await openapiTS(spec)));
    stampGenerated(schemaPath, {
      tool: "projen openapi (tsoa + Speakeasy + openapi-typescript)",
      source: `the tsoa controllers in ${p.relPath}`,
    });

    // 3) src/client.ts: a typed openapi-fetch client over those types.
    const clientPath = join(srcDir, "client.ts");
    makeWritable(clientPath);
    writeFileSync(clientPath, CLIENT_SRC);
    stampGenerated(clientPath, {
      tool: "projen openapi (openapi-fetch)",
      source: "./schema",
    });

    written.push(outDir);
    logger.success(`openapi/${leaf} (from ${p.relPath})`);
  }
  return written;
}
