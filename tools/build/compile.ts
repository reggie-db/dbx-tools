import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { stageNodeModules } from "./npm-runtime.ts";

const [sourcePath, outputPath, metadataPath, toolingPath, runtimePath, ...dependencies] = process.argv.slice(2);
const output = resolve(outputPath!);
const tooling = resolve(toolingPath!);
const runtime = resolve(runtimePath!);
const metadata = JSON.parse(readFileSync(metadataPath!, "utf8"));
const work = join(output, ".work");
mkdirSync(work, { recursive: true });
cpSync(resolve(sourcePath!), work, { recursive: true, dereference: true });
stageNodeModules(work, [tooling, runtime], dependencies);
writeFileSync(join(work, "package.json"), JSON.stringify({ name: metadata.package, version: metadata.version }));
process.env.DBX_BUILD_MODULES = tooling;
const { generateBarrels } = await import("./barrels.ts");
generateBarrels({ dirs: [work] });
const config = {
  compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
    declaration: true, noCheck: true, jsx: "react-jsx", experimentalDecorators: true,
    esModuleInterop: true, resolveJsonModule: true, rewriteRelativeImportExtensions: true,
    allowImportingTsExtensions: true, skipLibCheck: true, rootDir: work, outDir: output,
    lib: metadata.kind === "shared" ? ["ES2022", "WebWorker"] : metadata.kind === "ui" ? ["ES2022", "DOM", "DOM.Iterable"] : ["ES2022"],
    types: metadata.kind === "shared" ? [] : ["node"],
  },
  include: ["src/**/*.ts", "src/**/*.tsx", "bin/**/*.ts", "api.ts", "exports.ts"],
  exclude: ["node_modules", "**/*.test.ts", "**/*.spec.ts", "src/**/*.d.ts"],
};
writeFileSync(join(work, "tsconfig.json"), JSON.stringify(config));
const result = spawnSync(process.execPath, [join(tooling, "node_modules/typescript/bin/tsc"), "--project", join(work, "tsconfig.json")], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0) throw new Error(`TypeScript emit failed for ${metadata.package}`);
const exports = Object.fromEntries(Object.entries(metadata.exports).map(([key, value]) => [key, String(value).replace(/\.tsx?$/, ".js")]));
writeFileSync(join(output, "package.json"), JSON.stringify({ name: metadata.package, version: metadata.version, type: "module", main: "./api.js", types: "./api.d.ts", exports }, null, 2));
for (const file of new Bun.Glob("**/*").scanSync({ cwd: work, onlyFiles: true })) {
  if (file.startsWith("node_modules/") || /\.(?:[cm]?tsx?|json)$/.test(file)) continue;
  mkdirSync(dirname(join(output, file)), { recursive: true });
  cpSync(join(work, file), join(output, file));
}
if (existsSync(join(work, "api.ts"))) cpSync(join(work, "api.ts"), join(output, "api.ts"));
rmSync(work, { recursive: true, force: true });
