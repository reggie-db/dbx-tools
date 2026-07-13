/**
 * OpenAPI generator (tsoa-based).
 *
 * Scans `server`/`node` packages for **tsoa controllers** (classes decorated
 * with `@Route`/`@Get`/... - no JSDoc, no YAML) and, for each package that has
 * them, generates a read-only `<root>/openapi/<name>` package:
 *
 *   - `openapi.json`   - the OpenAPI 3 spec (tsoa `generateSpec`, from the types).
 *   - `src/schema.ts`  - types generated from the spec (openapi-typescript).
 *   - `src/client.ts`  - a typed `openapi-fetch` client, usable client-side.
 *
 * tsoa infers the whole spec from the controller decorators + TypeScript types, so
 * the API surface is annotated on the methods and nothing is hand-written twice.
 * The generated client stack is openapi-typescript + openapi-fetch (openapi-ts.dev),
 * the best-of-2026 choice since AppKit ships no OpenAPI client generator.
 *
 * `tsoa`, `typescript`, and `openapi-typescript` are loaded lazily (heavy, and only
 * needed for `dbxtools openapi`), so importing this module stays cheap.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as ts from "typescript";
import { logger } from "../log";
import { makeReadonly, makeWritable, stampGenerated } from "./generated";
import {
  type WorkspacePackage,
  isModuleFile,
  repoRoot,
  walkFiles,
  workspacePackages,
} from "./workspace";

const log = logger.withTag("projen:openapi");

/** The tag (and folder) the generated openapi client packages are written under. */
const OPENAPI_TAG = "openapi";
/** A file that imports tsoa's decorators is (part of) a controller surface. */
const TSOA_IMPORT = /from\s+['"](?:tsoa|@tsoa\/runtime)['"]/;

const CLIENT_SRC = `import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema";

/** Create a typed OpenAPI client (openapi-fetch); safe to use in the browser. */
export function createApiClient(options?: ClientOptions) {
  return createClient<paths>(options);
}
`;

/** True if any module file in `<pkg>/src` imports tsoa (i.e. declares a controller). */
export function hasTsoaControllers(pkg: Pick<WorkspacePackage, "dir">): boolean {
  return walkFiles(join(pkg.dir, "src"))
    .filter(isModuleFile)
    .some((f) => TSOA_IMPORT.test(readFileSync(f, "utf8")));
}

/** `server`/`node` packages (never the generated `openapi` tag) with tsoa controllers. */
function controllerPackages(): WorkspacePackage[] {
  return workspacePackages().filter(
    (p) => (p.tags.includes("server") || p.tags.includes("node")) && hasTsoaControllers(p),
  );
}

/** True if the changed path is a source file that looks like a tsoa controller. */
export function isTsoaController(path: string): boolean {
  const posix = path.replace(/\\/g, "/");
  return (
    !posix.includes(`/${OPENAPI_TAG}/`) &&
    isModuleFile(path) &&
    existsSync(path) &&
    TSOA_IMPORT.test(readFileSync(path, "utf8"))
  );
}

/**
 * Regenerate the `openapi` packages from every tsoa-controller package. Returns the
 * package dirs it wrote, so the caller can re-synth (to configure/link them) and
 * rebuild their barrels.
 */
export async function generateOpenapi(): Promise<string[]> {
  const pkgs = controllerPackages();
  if (pkgs.length === 0) {
    log.info("no tsoa controllers found in any server/node package");
    return [];
  }

  // Lazy, resilient loads: tsoa + typescript are CJS (require), openapi-typescript
  // is ESM (dynamic import).
  const require = createRequire(import.meta.url);
  const { generateSpec } = require("tsoa") as typeof import("tsoa");
  const tsRuntime = require("typescript") as typeof ts;
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
    // its npm name - `p.name` is now the (possibly-overridden) manifest name.
    const leaf = p.relPath.split("/").pop() ?? p.relPath;
    const outDir = join(repoRoot, p.root, OPENAPI_TAG, leaf);
    const srcDir = join(outDir, "src");
    mkdirSync(srcDir, { recursive: true });

    // 1) tsoa writes <outDir>/openapi.json from the controllers' decorators + types.
    const specPath = join(outDir, "openapi.json");
    makeWritable(specPath);
    await generateSpec(
      {
        entryFile: "",
        noImplicitAdditionalProperties: "throw-on-extras",
        controllerPathGlobs: [join(p.dir, "src/**/*.ts")],
        outputDirectory: outDir,
        specFileBaseName: "openapi",
        specVersion: 3,
        name: `${p.relPath} API`,
        version: "0.0.0",
      },
      compilerOptions,
    );
    makeReadonly(specPath);

    // 2) src/schema.ts: types generated from the spec (openapi-typescript).
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    const schemaPath = join(srcDir, "schema.ts");
    makeWritable(schemaPath);
    writeFileSync(schemaPath, astToString(await openapiTS(spec)));
    stampGenerated(schemaPath, {
      tool: "dbxtools openapi (tsoa + openapi-typescript)",
      source: `the tsoa controllers in ${p.relPath}`,
    });

    // 3) src/client.ts: a typed openapi-fetch client over those types.
    const clientPath = join(srcDir, "client.ts");
    makeWritable(clientPath);
    writeFileSync(clientPath, CLIENT_SRC);
    stampGenerated(clientPath, { tool: "dbxtools openapi (openapi-fetch)", source: "./schema" });

    written.push(outDir);
    log.success(`openapi/${leaf} (from ${p.relPath})`);
  }
  return written;
}
