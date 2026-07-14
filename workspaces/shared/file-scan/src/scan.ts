import { globIterateSync, IgnoreLike, type GlobOptionsWithFileTypesUnset } from "glob";
import { ignoreMatcher, IgnorePatternsOptions } from "./match";

/** Options for {@link fileScan}: glob options plus the shared ignore-group toggles. */
export type FileScanOptions = Omit<GlobOptionsWithFileTypesUnset, "dot"> & {
  ignoreOptions?: IgnorePatternsOptions;
};

/**
 * Recursively lists files matching `pattern`, ignoring the shared default groups
 * plus any caller `ignore` patterns. Glob matches those patterns natively, so the
 * ignore list is the same one {@link fileWatch} feeds through its matchers.
 */
export function fileScan(
  pattern: string | string[],
  options?: FileScanOptions,
): Generator<string, void, void> {
  const { ignore, ignoreOptions, ...globOptions } = options ?? {};
  return globIterateSync(pattern, {
    ...globOptions,
    ignore: normalizeIgnore(ignore, ignoreOptions),
  });
}

/**
 * Builds the {@link IgnoreLike} object fileScan hands to `glob`.
 *
 * A caller-supplied `IgnoreLike` (an object, not string/array) is consulted
 * first - its `ignored`/`childrenIgnored` win - after which the shared
 * {@link ignoreMatcher} (the SAME matcher `fileWatch` uses) decides based on the
 * package-relative path. `cacheDirectoryStats` is enabled because glob probes
 * many paths per directory. Caller string/array patterns are merged into the
 * matcher, and `add` forwards to both the caller object and the matcher.
 */
function normalizeIgnore(
  ignore: string | string[] | IgnoreLike | undefined,
  options: IgnorePatternsOptions | undefined,
): IgnoreLike {
  const callerIgnore =
    ignore !== undefined && !Array.isArray(ignore) && typeof ignore !== "string"
      ? ignore
      : undefined;

  const callerPatterns =
    typeof ignore === "string" ? [ignore] : Array.isArray(ignore) ? ignore : [];

  const matcher = ignoreMatcher({ ...options, cacheDirectoryStats: true }, ...callerPatterns);

  return {
    ignored(path) {
      let ignored = false;
      if (callerIgnore?.ignored?.(path) === true) {
        ignored = true;
      } else {
        ignored = matcher.match(path.relative(), "stat");
      }
      return ignored;
    },

    childrenIgnored(path) {
      let ignored = false;
      if (callerIgnore?.childrenIgnored?.(path) === true) {
        ignored = true;
      } else {
        ignored = matcher.match(path.relative(), "stat");
      }
      return ignored;
    },

    add(pattern) {
      callerIgnore?.add?.(pattern);
      matcher.addPattern(pattern);
    },
  };
}

// Manual demo: run this file directly (e.g. `tsx src/scan.ts`) to print the
// files fileScan keeps for this package under the given ignore options.
if (import.meta.main) {
  const cwd = process.cwd();
  console.log(`Scanning: ${cwd}`);

  const files = fileScan("**", {
    cwd: "workspaces/shared/file-scan",
    ignore: ["**/index.ts", "**/example/**"],
    ignoreOptions: {
      testPatterns: true,
    },
  });
  for (const file of files) {
    console.log(file);
  }
}
