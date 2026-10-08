import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as projectUtils from "@dbx-tools/core/project-utils";
import { object } from "@dbx-tools/shared-core";

export interface ServicePackage {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  bin(name?: string): string;
  dependencies(): Readonly<Record<string, string>>;
}

export function resolveServicePackage(
  reference: string,
  cwd: string = process.cwd(),
): ServicePackage {
  const local = localManifest(reference);
  if (local) return servicePackage(local);

  const name = reference;
  const installed = installedManifest(name);
  if (installed) return servicePackage(installed, name);

  const root = projectUtils.root(cwd);
  if (!root) throw new Error(`could not resolve package: ${name}`);
  const manifest = readRecord(join(root, "package.json"));
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : [];
  for (const member of workspaces) {
    if (typeof member !== "string" || /[*?[\]{}]/.test(member)) continue;
    const path = join(root, member, "package.json");
    if (!existsSync(path)) continue;
    const candidate = readRecord(path);
    if (candidate.name === name) return servicePackage(path, name);
  }
  throw new Error(`could not resolve installed or workspace package: ${name}`);
}

export function servicePackageDefaults(pkg: ServicePackage): {
  id: string;
  name: string;
} {
  const segments = pkg.name.replace(/^@/, "").split("/");
  const rawName = segments.at(-1)!;
  const rawScope = segments.length > 1 ? segments[0]!.split("-")[0]! : "";
  const name = rawName.replace(/^cli-/, "").replaceAll("-", " ");
  return {
    id: pkg.name
      .replace(/^@/, "")
      .replaceAll("/", ".")
      .replace(/[^a-z0-9._-]+/gi, "-"),
    name: [rawScope, name].filter(Boolean).join(" "),
  };
}

function localManifest(reference: string): string | undefined {
  let path: string;
  if (reference.startsWith("file:")) {
    path = fileURLToPath(reference);
  } else if (isAbsolute(reference)) {
    path = reference;
  } else {
    return undefined;
  }
  let current = existsSync(path) ? dirname(path) : path;
  while (true) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) return manifest;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function installedManifest(name: string): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(`${name}/package.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}

function servicePackage(manifestPath: string, expectedName?: string): ServicePackage {
  const manifest = readRecord(manifestPath);
  if (typeof manifest.name !== "string" || !manifest.name) {
    throw new Error(`package has no name: ${manifestPath}`);
  }
  if (expectedName && manifest.name !== expectedName) {
    throw new Error(`resolved package name does not match ${expectedName}: ${manifestPath}`);
  }
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error(`package has no version: ${manifestPath}`);
  }
  const directory = dirname(manifestPath);
  return {
    directory,
    name: manifest.name,
    version: manifest.version,
    bin(name) {
      return resolveBin(directory, manifest.bin, name);
    },
    dependencies() {
      const dependencies = object.isRecord(manifest.dependencies)
        ? Object.keys(manifest.dependencies)
        : [];
      const require = createRequire(manifestPath);
      return Object.fromEntries(
        dependencies.map((dependency) => {
          const path = require.resolve(`${dependency}/package.json`);
          const resolved = readRecord(path);
          if (typeof resolved.version !== "string" || !resolved.version) {
            throw new Error(`dependency has no version: ${path}`);
          }
          return [dependency, resolved.version];
        }),
      );
    },
  };
}

function resolveBin(directory: string, value: unknown, name?: string): string {
  if (typeof value === "string") {
    if (name) throw new Error(`package exposes one unnamed bin, not ${name}`);
    return resolve(directory, value);
  }
  if (!object.isRecord(value)) throw new Error("package has no bin");
  if (name) {
    const target = value[name];
    if (typeof target !== "string") throw new Error(`package has no bin named ${name}`);
    return resolve(directory, target);
  }
  const targets = Object.values(value).filter(
    (target): target is string => typeof target === "string",
  );
  if (targets.length !== 1) {
    throw new Error("package has multiple bins; command.binName is required");
  }
  return resolve(directory, targets[0]!);
}

function readRecord(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!object.isRecord(value)) throw new Error(`package manifest is not an object: ${path}`);
  return value;
}
