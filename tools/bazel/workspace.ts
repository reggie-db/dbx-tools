import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const resolveRepoRoot = () => root;
export const toPosix = (path: string) => path.replaceAll("\\", "/");
export const isModuleFile = (file: string) => /\.(?:[cm]?[jt]sx?)$/.test(file)
  && !/(?:^|\/)index\.[^.]+$|\.(?:test|spec)\.|\.d\.ts$/.test(file);
export const find = {
  findFiles(pattern: string, options: { cwd: string }) {
    return new Bun.Glob(pattern).scanSync({ cwd: options.cwd, onlyFiles: true });
  },
};
export const json = { parseRecord: (source: string) => JSON.parse(source) };
export const string = {
  *tokenizeWithOptions(_options: unknown, value: string) {
    const acronyms = new Set(["fs", "ai", "api", "url", "http", "https", "sql", "id", "ip", "json", "jwt", "mcp", "sdk", "sse"]);
    for (const token of value.replace(/([a-z\d])([A-Z])/g, "$1 $2").split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
      yield acronyms.has(token.toLowerCase()) ? token.toUpperCase() : token[0]!.toUpperCase() + token.slice(1).toLowerCase();
    }
  },
  capitalize: (value: string) => value[0]!.toUpperCase() + value.slice(1),
  pluralize: (count: number, value: string) => `${count} ${value}${count === 1 ? "" : "s"}`,
};

export function manifestFiles(base: string, name: string): string[] {
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith(".") || ["node_modules", "target", "lib", "dist", "test", "fixtures"].includes(entry.name)) return [];
    const directory = join(base, entry.name);
    return existsSync(join(directory, name)) ? [join(directory, name)] : manifestFiles(directory, name);
  }).sort();
}

export function recordedPackages(projectRoot = root) {
  const rootManifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  return (rootManifest.workspaces as string[])
    .filter(directory => existsSync(join(projectRoot, directory, "src")))
    .map(directory => join(projectRoot, directory, "package.json"))
    .map((file) => {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    return { dir: resolve(file, ".."), name: manifest.name, tags: manifest.dbxToolsConfig?.tags ?? [], manifest };
  });
}
