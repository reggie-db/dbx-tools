import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { addExplicitInterfaceReexports, addTypeScriptExtensionsToBindingImports, makeDefaultedInterfaceParametersOptional } from "./uniffi.ts";

const [libraryPath, generatorPath, ubranPath, configPath, crate, module, outputPath] = process.argv.slice(2);
const library = resolve(libraryPath!);
const output = resolve(outputPath!);
const node = join(output, "typescript", "src");
const python = join(output, "python", ...module!.split("."));
const generatedPython = join(output, ".python");
mkdirSync(node, { recursive: true });
mkdirSync(python, { recursive: true });
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  process.stdout.write((result.stdout ?? "").replace(/\p{Extended_Pictographic}/gu, ""));
  process.stderr.write((result.stderr ?? "").replace(/\p{Extended_Pictographic}/gu, ""));
  if (result.status !== 0) throw new Error(`UniFFI command failed: ${command}`);
};
run(resolve(generatorPath!), ["generate", "--library", library, "--language", "python", "--config", resolve(configPath!), "--out-dir", generatedPython]);
const namespace = crate!.replaceAll("-", "_");
writeFileSync(join(python, "bindings.py"), readFileSync(join(generatedPython, `${namespace}.py`)));
writeFileSync(join(python, "__init__.py"), "");
rmSync(generatedPython, { recursive: true, force: true });
run(resolve(ubranPath!), ["generate", "napi", "bindings", "--library", "--ts-dir", node, "--lib-colocated", library]);
const modules = [];
for (const suffix of ["", "-ffi"]) {
  const generated = join(node, `${namespace}${suffix}.ts`);
  let source = readFileSync(generated, "utf8").replaceAll(`./${namespace}-ffi`, "./_bindings-ffi");
  source = makeDefaultedInterfaceParametersOptional(source);
  source = addTypeScriptExtensionsToBindingImports(source);
  const specifier = `./_bindings${suffix}.ts`;
  writeFileSync(join(node, `_bindings${suffix}.ts`), source);
  modules.push({ specifier, source });
  rmSync(generated);
}
const facade = "export * from './_bindings.ts';\nimport uniffiModule from './_bindings.ts';\nuniffiModule.initialize();\nexport { uniffiModule };\n";
writeFileSync(join(node, "bindings.ts"), addExplicitInterfaceReexports(facade, modules));
for (const file of readdirSync(node)) if (file === "index.ts") rmSync(join(node, file));
const libraryName =
  process.platform === "win32"
    ? `${namespace}.dll`
    : `lib${namespace}.${process.platform === "darwin" ? "dylib" : "so"}`;
cpSync(library, join(node, libraryName));
cpSync(library, join(python, libraryName));
