import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const link = (source: string, destination: string): void => {
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  symlinkSync(source, destination, "dir");
};

export function stagePackageNames(work: string, root: string, packages: readonly string[]): void {
  const modules = join(work, "node_modules");
  mkdirSync(modules, { recursive: true });
  for (const name of packages) {
    link(join(root, "node_modules", name), join(modules, name));
  }
}

export function stageDependencies(work: string, dependencies: readonly string[]): void {
  const modules = join(work, "node_modules");
  for (let offset = 0; offset < dependencies.length; offset += 2) {
    link(resolve(dependencies[offset + 1]!), join(modules, dependencies[offset]!));
  }
}

export function stageNodeModules(
  work: string,
  packageRoots: readonly string[],
  dependencies: readonly string[],
): void {
  const modules = join(work, "node_modules");
  mkdirSync(modules, { recursive: true });
  for (const root of packageRoots) {
    const packages: string[] = [];
    for (const pattern of ["*", "@*/*"]) {
      for (const name of new Bun.Glob(pattern).scanSync({
        cwd: join(root, "node_modules"),
        onlyFiles: false,
      })) {
        if (name.startsWith(".") || (name.startsWith("@") && !name.includes("/"))) continue;
        packages.push(name);
      }
    }
    stagePackageNames(work, root, packages);
  }
  stageDependencies(work, dependencies);
}
