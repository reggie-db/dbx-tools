import { createRequire } from "node:module";
import { resolve } from "node:path";

export function buildRequire(name: string) {
  const directory = process.env.DBX_BUILD_MODULES;
  if (!directory) throw new Error("Run this generator through its Buck2 target");
  return createRequire(resolve(directory, "package.json"))(name);
}
export const resolveRepoRoot = () => process.cwd();
export const recordedPackages = (_root: string): { dir: string }[] => [];
export const toPosix = (path: string) => path.replaceAll("\\", "/");
export const isModuleFile = (file: string) => /\.(?:[cm]?[jt]sx?)$/.test(file)
  && !/(?:^|\/)(?:index|api)\.[^.]+$|\.(?:test|spec)\.|\.d\.ts$/.test(file);
export const find = {
  findFiles(pattern: string, options: { cwd: string }) {
    return new Bun.Glob(pattern).scanSync({ cwd: options.cwd, onlyFiles: true });
  },
};
export const json = { parseRecord: (source: string) => JSON.parse(source) };
export const string = {
  *tokenizeWithOptions(_options: unknown, value: string) {
    const acronyms = new Set(["fs", "ai", "api", "url", "http", "https", "sql", "ui", "id", "ip", "json", "jwt", "mcp", "sdk", "sse"]);
    for (const token of value.replace(/([a-z\d])([A-Z])/g, "$1 $2").split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
      yield acronyms.has(token.toLowerCase()) ? token.toUpperCase() : token[0]!.toUpperCase() + token.slice(1).toLowerCase();
    }
  },
  capitalize: (value: string) => value[0]!.toUpperCase() + value.slice(1),
  pluralize: (count: number, value: string) => `${count} ${value}${count === 1 ? "" : "s"}`,
};
