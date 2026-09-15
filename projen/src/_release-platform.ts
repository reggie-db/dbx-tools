import { Option } from "commander";
import type { VersionLevel } from "./workspace-version.ts";

/** Supported semantic version increments for release commands. */
export const RELEASE_LEVELS = [
  "patch",
  "minor",
  "major",
] as const satisfies readonly VersionLevel[];

/** Supported release operating systems. */
export const RELEASE_OSES = ["darwin", "linux", "win32"] as const;

/** Supported release CPU architectures. */
export const RELEASE_ARCHES = ["arm64", "x64"] as const;

/** Release operating system selector. */
export type ReleaseOs = (typeof RELEASE_OSES)[number];

/** Release CPU architecture selector. */
export type ReleaseArch = (typeof RELEASE_ARCHES)[number];

export type { VersionLevel } from "./workspace-version.ts";

function collectValue<T extends string>(value: T, previous: T[]): T[] {
  return [...previous, value];
}

/** Commander option for selecting the semantic release increment. */
export function releaseLevelOption(): Option {
  return new Option("-l, --level <level>", "semver increment")
    .choices([...RELEASE_LEVELS])
    .default("patch");
}

/** Repeatable Commander option for release operating systems. */
export function releaseOperatingSystemOption(): Option {
  return new Option("--os <os>", "release operating system, repeatable; crossed with every --arch")
    .choices([...RELEASE_OSES])
    .argParser((value, previous: ReleaseOs[]) => collectValue(value as ReleaseOs, previous))
    .default([] as ReleaseOs[]);
}

/** Repeatable Commander option for release CPU architectures. */
export function releaseArchitectureOption(): Option {
  return new Option(
    "--arch <arch>",
    "release CPU architecture, repeatable; crossed with every --os",
  )
    .choices([...RELEASE_ARCHES])
    .argParser((value, previous: ReleaseArch[]) => collectValue(value as ReleaseArch, previous))
    .default([] as ReleaseArch[]);
}

/** Cartesian-product release target filter shared by release commands. */
export function releasePlatformFilter(
  operatingSystems: readonly string[],
  architectures: readonly string[],
): string {
  if ((operatingSystems.length === 0) !== (architectures.length === 0)) {
    throw new Error("--os and --arch must be used together");
  }
  return operatingSystems
    .flatMap((operatingSystem) =>
      architectures.map((architecture) => `${operatingSystem}:${architecture}`),
    )
    .join(",");
}
