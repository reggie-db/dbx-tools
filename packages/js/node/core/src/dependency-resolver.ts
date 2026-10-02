/**
 * Resolve npm dependency specifiers against a registry.
 *
 * Callers pass an already-parsed `package.json`. The functions never write that
 * project and never run an installer: they GET packuments over HTTP and walk
 * declared plus transitive `dependencies`. Exact versions stay exact when they
 * exist; ranges stay ranges when a published version satisfies them.
 *
 * `registryUrl` defaults to {@link npmRegistry} from `project-utils`.
 *
 * @module
 */

import { json, object } from "@dbx-tools/shared-core";
import { maxSatisfying, satisfies, valid, validRange } from "semver";

import { npmRegistry } from "./project-utils.ts";

const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";
const PACKUMENT_TIMEOUT_MS = 30_000;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const DEFAULT_MAX_ITERATIONS = 100;

type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

type PackageInfo = {
  name: string;
  versions: string[];
  latest?: string;
  dependencies: Record<string, Record<string, string>>;
};

/** Registry and traversal policy for dependency resolution. */
export type DependencyResolverOptions = {
  /** Graph-walk attempts before giving up. Defaults to 100. */
  maxIterations?: number;
  /**
   * Registry origin used for packument GETs. Defaults to
   * `projectUtils.npmRegistry()` (env, npmrc, bunfig, pnpm yaml, then public npm).
   */
  registryUrl?: string | URL;
  packageInfo?: (name: string) => Promise<PackageInfo | undefined>;
  skip?: ReadonlySet<string>;
};

/**
 * Package identity plus optional exact version and/or semver range.
 *
 * `semver` is accepted as an input alias for `version`.
 */
export type DependencyInfo = {
  name: string;
  version?: string;
  semver?: string;
  range?: string;
};

/** Concrete registry version, plus the original range when one was requested. */
export type ResolvedNpmVersion = {
  name: string;
  version: string;
  range?: string;
};

/** String specifier or structured `{ version, range, name? }` value. */
export type NpmSpecifierInput = string | Omit<DependencyInfo, "name"> | DependencyInfo;

/** Registry dependency maps with resolved versions and retained ranges. */
export type ResolvedNpmDependencies = {
  dependencies: Record<string, ResolvedNpmVersion>;
  devDependencies: Record<string, ResolvedNpmVersion>;
  optionalDependencies: Record<string, ResolvedNpmVersion>;
  peerDependencies: Record<string, ResolvedNpmVersion>;
  overrides: Record<string, ResolvedNpmVersion>;
};

/** A package whose requested specifier is not in the configured registry. */
export type MissingDependencyInfo = DependencyInfo;

/**
 * Return packages the configured registry cannot satisfy for this manifest.
 *
 * Walks declared registry specifiers and each reachable packument
 * `dependencies` map. The input object is not mutated.
 */
export async function missingDependencies(
  manifest: Record<string, unknown>,
  options: DependencyResolverOptions = {},
): Promise<MissingDependencyInfo[]> {
  const packageInfo = options.packageInfo ?? createPackageInfoLookup(options.registryUrl);
  const overrides = overrideMap(manifest);
  const missing = new Map<string, DependencyInfo>();
  const visited = new Set<string>();

  const consider = async (dep: DependencyInfo): Promise<void> => {
    if (!isRegistrySpecifier(toNpmSpecifier(dep))) return;
    const request = overrides[dep.name] ?? dep;
    const resolved = await matchingPublishedVersion(request, packageInfo);
    if (resolved) {
      await walk(resolved, packageInfo, visited, consider, options.registryUrl);
      return;
    }
    if (!missing.has(dep.name)) missing.set(dep.name, request);
  };

  await Promise.all(Object.values(declaredDependencies(manifest)).map(consider));
  return [...missing.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Return a registry version for one package.
 *
 * `request` may be a package name, `name@version` / `name@range`, or a
 * structured `{ name, version?, range? }` object. A second string argument is
 * treated as the specifier. An exact version that exists is returned
 * unchanged. A range is retained when a published version satisfies it.
 */
export async function resolveVersion(
  request: string | DependencyInfo,
  specifierOrOptions?: string | DependencyResolverOptions,
  maybeOptions?: DependencyResolverOptions,
): Promise<ResolvedNpmVersion | undefined> {
  const { dependency, options } = resolveVersionArgs(request, specifierOrOptions, maybeOptions);
  if (dependency.version && !isRegistrySpecifier(dependency.version)) {
    return {
      name: dependency.name,
      version: dependency.version,
      ...(dependency.range === undefined ? {} : { range: dependency.range }),
    };
  }
  if (dependency.range && !isRegistrySpecifier(dependency.range)) {
    return { name: dependency.name, version: dependency.range, range: dependency.range };
  }
  const packageInfo = options.packageInfo ?? createPackageInfoLookup(options.registryUrl);
  const info = await packageInfo(dependency.name);
  if (!info) return undefined;
  return pickVersion(info, dependency, options.skip);
}

function resolveVersionArgs(
  request: string | DependencyInfo,
  specifierOrOptions?: string | DependencyResolverOptions,
  maybeOptions?: DependencyResolverOptions,
): { dependency: DependencyInfo; options: DependencyResolverOptions } {
  if (typeof specifierOrOptions === "string") {
    const name = typeof request === "string" ? request : request.name;
    return {
      dependency: specifierToDependency(name, specifierOrOptions),
      options: maybeOptions ?? {},
    };
  }
  return {
    dependency: parseDependencyRequest(request),
    options: specifierOrOptions ?? maybeOptions ?? {},
  };
}

/**
 * Return resolvable dependency specifiers for an in-memory `package.json`.
 *
 * The input object is not mutated. Unavailable registry packages (or their
 * parents) are pinned until the packument graph is complete.
 */
export async function resolveDependencies(
  manifest: Record<string, unknown>,
  options: DependencyResolverOptions = {},
): Promise<ResolvedNpmDependencies> {
  const working = structuredClone(manifest);
  const packageInfo = options.packageInfo ?? createPackageInfoLookup(options.registryUrl);
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const attempted = new Set<string>();
  const shared: DependencyResolverOptions = {
    packageInfo,
    ...(options.registryUrl === undefined ? {} : { registryUrl: options.registryUrl }),
  };

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const missing = await missingDependencies(working, shared);
    if (missing.length === 0) return snapshot(working, packageInfo);

    let changed = false;
    for (const entry of missing) {
      const pin = await pinForMissing(entry, working, packageInfo, attempted);
      if (pin) changed = pinPackage(working, pin) || changed;
    }
    if (!changed) {
      throw new Error(
        `No remaining registry pin for: ${missing.map((entry) => entry.name).join(", ")}`,
      );
    }
  }

  throw new Error(`Reached ${maxIterations} pin attempts without a complete registry graph.`);
}

async function matchingPublishedVersion(
  request: DependencyInfo,
  packageInfo: (name: string) => Promise<PackageInfo | undefined>,
): Promise<ResolvedNpmVersion | undefined> {
  const info = await packageInfo(request.name);
  if (!info) return undefined;
  const version = publishedMatch(info, request);
  if (!version) return undefined;
  return request.range === undefined
    ? { name: info.name, version }
    : { name: info.name, version, range: request.range };
}

function publishedMatch(info: PackageInfo, request: DependencyInfo): string | undefined {
  if (request.range && validRange(request.range)) {
    if (
      request.version &&
      info.versions.includes(request.version) &&
      satisfies(request.version, request.range)
    ) {
      return request.version;
    }
    return maxSatisfying(info.versions, request.range) ?? undefined;
  }
  if (request.version) {
    if (info.versions.includes(request.version)) return request.version;
    if (validRange(request.version)) {
      return maxSatisfying(info.versions, request.version) ?? undefined;
    }
    return undefined;
  }
  return newestPublished(info, info.versions);
}

async function walk(
  resolved: ResolvedNpmVersion,
  packageInfo: (name: string) => Promise<PackageInfo | undefined>,
  visited: Set<string>,
  consider: (dep: DependencyInfo) => Promise<void>,
  registryUrl?: string | URL,
): Promise<void> {
  const key = `${resolved.name}@${resolved.version}`;
  if (visited.has(key)) return;
  visited.add(key);
  const info = await packageInfo(resolved.name);
  let deps = info?.dependencies[resolved.version];
  if (deps === undefined && info) {
    deps = await loadVersionDependencies(resolved.name, resolved.version, registryUrl);
    info.dependencies[resolved.version] = deps;
  }
  await Promise.all(
    Object.entries(deps ?? {}).map(([name, spec]) => consider(specifierToDependency(name, spec))),
  );
}

async function snapshot(
  manifest: Record<string, unknown>,
  packageInfo: (name: string) => Promise<PackageInfo | undefined>,
): Promise<ResolvedNpmDependencies> {
  return {
    dependencies: await specifierMap(manifest, "dependencies", packageInfo),
    devDependencies: await specifierMap(manifest, "devDependencies", packageInfo),
    optionalDependencies: await specifierMap(manifest, "optionalDependencies", packageInfo),
    peerDependencies: await specifierMap(manifest, "peerDependencies", packageInfo),
    overrides: await structuredMap(overrideMap(manifest), packageInfo),
  };
}

async function specifierMap(
  manifest: Record<string, unknown>,
  field: DependencyField,
  packageInfo: (name: string) => Promise<PackageInfo | undefined>,
): Promise<Record<string, ResolvedNpmVersion>> {
  return structuredMap(dependencyMap(manifest, field), packageInfo);
}

async function structuredMap(
  specs: Record<string, DependencyInfo>,
  packageInfo: (name: string) => Promise<PackageInfo | undefined>,
): Promise<Record<string, ResolvedNpmVersion>> {
  const out: Record<string, ResolvedNpmVersion> = {};
  for (const [name, spec] of Object.entries(specs)) {
    out[name] = await structuredSpecifier(spec, packageInfo);
  }
  return out;
}

async function structuredSpecifier(
  spec: DependencyInfo,
  packageInfo: (name: string) => Promise<PackageInfo | undefined>,
): Promise<ResolvedNpmVersion> {
  const resolved = await resolveVersion(spec, { packageInfo });
  if (resolved) return resolved;
  const fallback = spec.version ?? spec.range ?? spec.semver;
  return fallback === undefined
    ? { name: spec.name, version: "*" }
    : { name: spec.name, version: fallback };
}

function parseDependencyRequest(request: string | DependencyInfo): DependencyInfo {
  if (typeof request !== "string") return normalizeDependency(request);
  const name = stripVersion(request);
  if (name === request) return { name };
  if (!request.startsWith(`${name}@`)) return { name };
  return specifierToDependency(name, request.slice(name.length + 1));
}

function specifierToDependency(name: string, spec: string): DependencyInfo {
  if (!spec || spec === "latest") return { name };
  if (!isRegistrySpecifier(spec)) return { name, version: spec };
  if (valid(spec)) return { name, version: spec };
  if (validRange(spec)) return { name, range: spec };
  return { name, version: spec };
}

function normalizeDependency(request: DependencyInfo): DependencyInfo {
  const version = request.version ?? request.semver;
  const range = request.range;
  const out: DependencyInfo = { name: request.name };
  if (version && !valid(version) && !range && validRange(version) && isRegistrySpecifier(version)) {
    out.range = version;
    return out;
  }
  if (version) out.version = version;
  if (range) out.range = range;
  return out;
}

function parseSpecifierInput(name: string, value: unknown): DependencyInfo | undefined {
  if (typeof value === "string") return specifierToDependency(name, value);
  if (!object.isRecord(value)) return undefined;
  const version = typeof value.version === "string" ? value.version : undefined;
  const semverValue = typeof value.semver === "string" ? value.semver : undefined;
  const range = typeof value.range === "string" ? value.range : undefined;
  const entryName = typeof value.name === "string" ? value.name : name;
  if (!version && !semverValue && !range) return undefined;
  return normalizeDependency({ name: entryName, version, semver: semverValue, range });
}

function dependencyMap(
  manifest: Record<string, unknown>,
  field: DependencyField,
): Record<string, DependencyInfo> {
  return parseDependencyField(manifest[field]);
}

function parseDependencyField(value: unknown): Record<string, DependencyInfo> {
  if (!object.isRecord(value)) return {};
  const out: Record<string, DependencyInfo> = {};
  for (const [name, spec] of Object.entries(value)) {
    const parsed = parseSpecifierInput(name, spec);
    if (parsed) out[name] = parsed;
  }
  return out;
}

function declaredDependencies(manifest: Record<string, unknown>): Record<string, DependencyInfo> {
  const out: Record<string, DependencyInfo> = {};
  for (const field of DEPENDENCY_FIELDS) Object.assign(out, dependencyMap(manifest, field));
  return out;
}

function isRegistrySpecifier(spec: string): boolean {
  return !/^(workspace:|catalog:|file:|link:|git\+|github:|https?:|npm:)/i.test(spec);
}

function overrideMap(manifest: Record<string, unknown>): Record<string, DependencyInfo> {
  return parseDependencyField(manifest.overrides);
}

function toNpmSpecifier(dependency: DependencyInfo): string {
  if (dependency.range && dependency.version && isRegistrySpecifier(dependency.range)) {
    if (valid(dependency.version) && satisfies(dependency.version, dependency.range)) {
      return dependency.range;
    }
  }
  if (dependency.range) return dependency.range;
  if (dependency.version) return dependency.version;
  return "*";
}

function pinPackage(manifest: Record<string, unknown>, resolved: ResolvedNpmVersion): boolean {
  let changed = false;
  const overrides = overrideMap(manifest);
  const overridePin: DependencyInfo = { name: resolved.name, version: resolved.version };
  if (toNpmSpecifier(overrides[resolved.name] ?? { name: resolved.name }) !== resolved.version) {
    overrides[resolved.name] = overridePin;
    manifest.overrides = Object.fromEntries(
      Object.entries(overrides).map(([name, dependency]) => [name, dependency]),
    );
    changed = true;
  }
  const depPin: DependencyInfo = {
    name: resolved.name,
    version: resolved.version,
    ...(resolved.range === undefined ? {} : { range: resolved.range }),
  };
  for (const field of DEPENDENCY_FIELDS) {
    const deps = dependencyMap(manifest, field);
    const current = deps[resolved.name];
    if (!current) continue;
    if (!isRegistrySpecifier(toNpmSpecifier(current))) continue;
    if (sameDependency(current, depPin)) continue;
    deps[resolved.name] = depPin;
    manifest[field] = deps;
    changed = true;
  }
  return changed;
}

function sameDependency(left: DependencyInfo, right: DependencyInfo): boolean {
  return left.version === right.version && left.range === right.range;
}

function newestFirst(versions: readonly string[]): string[] {
  return [...versions].sort((left, right) =>
    right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }),
  );
}

function pickVersion(
  info: PackageInfo,
  request: DependencyInfo,
  skip?: ReadonlySet<string>,
): ResolvedNpmVersion | undefined {
  const versions = info.versions.filter((version) => !skip?.has(version));
  if (versions.length === 0) return undefined;
  const fallback = newestPublished(info, versions);
  if (!fallback) return undefined;
  if (request.range && validRange(request.range)) {
    const matched = maxSatisfying(versions, request.range);
    if (
      request.version &&
      versions.includes(request.version) &&
      satisfies(request.version, request.range)
    ) {
      return { name: info.name, version: request.version, range: request.range };
    }
    return matched
      ? { name: info.name, version: matched, range: request.range }
      : { name: info.name, version: fallback, range: request.range };
  }
  if (request.version) {
    return {
      name: info.name,
      version: versions.includes(request.version) ? request.version : fallback,
    };
  }
  return { name: info.name, version: fallback };
}

function newestPublished(info: PackageInfo, versions: readonly string[]): string | undefined {
  if (info.latest && versions.includes(info.latest)) return info.latest;
  return newestFirst(versions)[0];
}

function skippedVersions(name: string, attempted: ReadonlySet<string>): Set<string> {
  const prefix = `${name}@`;
  const skipped = new Set<string>();
  for (const key of attempted) {
    if (key.startsWith(prefix)) skipped.add(key.slice(prefix.length));
  }
  return skipped;
}

function stripVersion(value: string): string {
  if (value.startsWith("@")) {
    const slash = value.indexOf("/");
    const at = value.indexOf("@", slash + 1);
    return at === -1 ? value : value.slice(0, at);
  }
  const at = value.indexOf("@");
  return at === -1 ? value : value.slice(0, at);
}

async function pinForMissing(
  missing: MissingDependencyInfo,
  manifest: Record<string, unknown>,
  packageInfo: (name: string) => Promise<PackageInfo | undefined>,
  attempted: Set<string>,
): Promise<ResolvedNpmVersion | undefined> {
  const resolved = await resolveVersion(missing, {
    packageInfo,
    skip: skippedVersions(missing.name, attempted),
  });
  if (resolved) {
    attempted.add(`${missing.name}@${resolved.version}`);
    return resolved;
  }

  for (const parent of await parentPackages(missing.name, manifest, packageInfo)) {
    const info = await packageInfo(parent);
    if (!info) continue;
    const version = compatibleParentVersion(missing.name, info, attempted);
    if (!version) continue;
    attempted.add(`${parent}@${version}`);
    const declared = declaredDependencies(manifest)[parent] ?? { name: parent };
    return pickVersion({ ...info, versions: [version], latest: version }, declared);
  }
  return undefined;
}

function compatibleParentVersion(
  missing: string,
  info: PackageInfo,
  attempted: Set<string>,
): string | undefined {
  for (const version of newestFirst(info.versions)) {
    if (attempted.has(`${info.name}@${version}`)) continue;
    if (!(missing in (info.dependencies[version] ?? {}))) return version;
  }
  return undefined;
}

async function parentPackages(
  missing: string,
  manifest: Record<string, unknown>,
  packageInfo: (name: string) => Promise<PackageInfo | undefined>,
): Promise<string[]> {
  const declared = declaredDependencies(manifest);
  const declaredSpec = declared[missing];
  if (declaredSpec && isRegistrySpecifier(toNpmSpecifier(declaredSpec))) return [];
  const parents: string[] = [];
  for (const name of Object.keys(declared)) {
    if (name === missing || !isRegistrySpecifier(toNpmSpecifier(declared[name] ?? { name }))) {
      continue;
    }
    const info = await packageInfo(name);
    if (!info) continue;
    if (Object.values(info.dependencies).some((map) => missing in map)) parents.push(name);
  }
  return parents;
}

function resolveRegistryUrl(registryUrl?: string | URL): string {
  const raw =
    registryUrl?.toString() ||
    npmRegistry(null, { envVars: true })?.toString() ||
    DEFAULT_NPM_REGISTRY;
  return raw.replace(/\/+$/, "");
}

function encodePackageName(name: string): string {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    if (slash !== -1) {
      return `${name.slice(0, slash)}%2f${encodeURIComponent(name.slice(slash + 1))}`;
    }
  }
  return encodeURIComponent(name);
}

function packumentUrl(name: string, registryUrl?: string | URL): string {
  return `${resolveRegistryUrl(registryUrl)}/${encodePackageName(name)}`;
}

async function fetchRegistryJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(PACKUMENT_TIMEOUT_MS),
  }).catch(() => undefined);
  if (!response?.ok) return undefined;
  const text = await response.text();
  return json.parse(text);
}

function createPackageInfoLookup(
  registryUrl?: string | URL,
): (name: string) => Promise<PackageInfo | undefined> {
  const cache = new Map<string, Promise<PackageInfo | undefined>>();
  return (name) => {
    const cached = cache.get(name);
    if (cached) return cached;
    const pending = loadPackageInfo(name, registryUrl);
    cache.set(name, pending);
    void pending.then(undefined, () => {
      cache.delete(name);
    });
    return pending;
  };
}

async function loadPackageInfo(
  name: string,
  registryUrl?: string | URL,
): Promise<PackageInfo | undefined> {
  const packument = await fetchRegistryJson(packumentUrl(name, registryUrl));
  if (!object.isRecord(packument)) return undefined;
  const versions = publishedVersions(packument);
  if (versions.length === 0) return undefined;
  return {
    name,
    versions,
    latest: latestTag(packument) ?? versions.at(-1),
    dependencies: versionDependencies(packument),
  };
}

async function loadVersionDependencies(
  name: string,
  version: string,
  registryUrl?: string | URL,
): Promise<Record<string, string>> {
  const doc = await fetchRegistryJson(
    `${packumentUrl(name, registryUrl)}/${encodeURIComponent(version)}`,
  );
  if (!object.isRecord(doc)) return {};
  return stringMap(doc.dependencies);
}

function publishedVersions(packument: Record<string, unknown>): string[] {
  if (typeof packument.version === "string" && !packument.versions) {
    return [packument.version];
  }
  const versions = packument.versions;
  if (Array.isArray(versions)) {
    return versions.filter((value): value is string => typeof value === "string");
  }
  if (object.isRecord(versions)) return Object.keys(versions);
  return [];
}

function latestTag(packument: Record<string, unknown>): string | undefined {
  const tags = packument["dist-tags"];
  if (!object.isRecord(tags) || typeof tags.latest !== "string") return undefined;
  return tags.latest;
}

function versionDependencies(
  packument: Record<string, unknown>,
): Record<string, Record<string, string>> {
  const versions = packument.versions;
  if (!object.isRecord(versions)) {
    return typeof packument.version === "string"
      ? { [packument.version]: stringMap(packument.dependencies) }
      : {};
  }
  const out: Record<string, Record<string, string>> = {};
  for (const [version, value] of Object.entries(versions)) {
    if (object.isRecord(value)) out[version] = stringMap(value.dependencies);
  }
  return out;
}

function stringMap(value: unknown): Record<string, string> {
  if (!object.isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === "string") out[name] = spec;
  }
  return out;
}
