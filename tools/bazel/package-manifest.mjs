import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [input, output] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(input, "utf8"));
Object.assign(manifest, manifest.publishConfig ?? {});
function compiledExports(value) {
  if (typeof value === "string" && /\.[cm]?tsx?$/.test(value) && !value.endsWith(".d.ts")) {
    const stem = value.replace(/^\.\//, "").replace(/\.[cm]?tsx?$/, "");
    return { types: `./lib/${stem}.d.ts`, default: `./lib/${stem}.js` };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, compiledExports(entry)]));
  }
  return value;
}
manifest.exports = compiledExports(manifest.exports);
delete manifest.publishConfig;
delete manifest.scripts;
delete manifest.devDependencies;
delete manifest.dbxToolsConfig;
const destination = resolve(process.env.JS_BINARY__EXECROOT ?? process.cwd(), output);
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
