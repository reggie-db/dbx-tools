import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stageNodeModules } from "./npm-runtime.ts";

const args = process.argv.slice(2);
const [sourcePath, outputPath, metadataPath, toolingPath, runtimePath, pythonCountText] = args;
const pythonCount = Number.parseInt(pythonCountText!, 10);
const pythonPaths = args.slice(6, 6 + pythonCount);
const dependencies = args.slice(6 + pythonCount);
const output = resolve(outputPath!);
const tooling = resolve(toolingPath!);
const metadata = JSON.parse(readFileSync(metadataPath!, "utf8"));

mkdirSync(output, { recursive: true });
cpSync(resolve(sourcePath!), output, { recursive: true, dereference: true });
stageNodeModules(output, [tooling, resolve(runtimePath!)], dependencies);
if (pythonPaths.length > 0) {
  const python = join(output, "python");
  mkdirSync(python, { recursive: true });
  for (const path of pythonPaths) {
    cpSync(resolve(path), python, { recursive: true, dereference: true });
  }
}
writeFileSync(
  join(output, "package.json"),
  JSON.stringify({ name: metadata.package, type: "module", version: metadata.version }),
);
process.env.DBX_BUILD_MODULES = tooling;
const { generateBarrels } = await import("./barrels.ts");
generateBarrels({ dirs: [output] });
