import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.env.JS_BINARY__EXECROOT) process.chdir(process.env.JS_BINARY__EXECROOT);
const [input, output, moduleName] = process.argv.slice(2);
const source = resolve(input);
const destination = resolve(output, ...moduleName.split("."));
mkdirSync(destination, { recursive: true });
for (const directory of ["python", "native"]) {
  for (const file of readdirSync(join(source, directory))) {
    cpSync(join(source, directory, file), join(destination, file));
  }
}
