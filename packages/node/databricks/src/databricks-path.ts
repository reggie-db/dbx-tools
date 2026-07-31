/**
 * Databricks path recognition and normalization for {@link DatabricksFileSystem}.
 *
 * Roots may be written as:
 * - Unity Catalog volume: `/Volumes/catalog/schema/volume` (also accepts `/Volume/...`)
 * - Three-part volume id: `catalog.schema.volume` → `/Volumes/catalog/schema/volume`
 * - Home shorthand: `~` / `~/...` → `/Workspace/Users/<userName>/...`
 * - Workspace tree: `/Workspace/...`, `/Users/...`, `/Repos/...`, `/Shared/...`
 * - DBFS: `/dbfs/...`
 *
 * @module
 */

import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { posixPath } from "@dbx-tools/shared-fs";
import { getCurrentUserName } from "./workspace.ts";

/** Which Databricks Files API serves an absolute path. */
export type DatabricksFilesBackend = "workspace" | "volumes" | "dbfs";

/** `catalog.schema.volume` (no slashes, exactly three dotted segments). */
const VOLUME_THREE_PART = /^([^.\/\s]+)\.([^.\/\s]+)\.([^.\/\s]+)$/;

/** Options for synchronous {@link normalizeDatabricksRoot}. */
export interface NormalizeDatabricksRootOptions {
  /**
   * Username used to expand `~` → `/Workspace/Users/<userName>`.
   * Required when {@link root} is `~` or `~/...`. Prefer
   * {@link resolveDatabricksRoot} when the name should come from the workspace
   * client.
   */
  userName?: string;
}

/** Options for async {@link resolveDatabricksRoot}. */
export interface ResolveDatabricksRootOptions {
  /** Client used to resolve the current username for `~` expansion. */
  client?: WorkspaceClient;
}

/** True when {@link input} is `~` or a path under `~/`. */
export function isHomeRelativePath(input: string): boolean {
  const trimmed = input.trim();
  return trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\");
}

/**
 * Expand `~` / `~/...` to `/Workspace/Users/<userName>/...`.
 * Non-home inputs are returned unchanged (POSIX separators only).
 */
export function expandHomePath(input: string, userName: string): string {
  const trimmed = input.trim();
  const name = userName.trim();
  if (!name) {
    throw new TypeError("Databricks home expansion requires a non-empty userName");
  }
  if (!isHomeRelativePath(trimmed)) {
    return posixPath.toPosix(trimmed);
  }

  const home = `/Workspace/Users/${name}`;
  if (trimmed === "~") return home;
  const rest = posixPath.toPosix(trimmed.slice(1)).replace(/^\/+/, "");
  return rest ? `${home}/${rest}` : home;
}

/**
 * Normalize a Databricks filesystem root to an absolute POSIX path.
 *
 * - `catalog.schema.volume` → `/Volumes/catalog/schema/volume`
 * - `/Volume/...` → `/Volumes/...` (singular typo / shorthand)
 * - `~` / `~/...` → `/Workspace/Users/<userName>/...` (needs {@link NormalizeDatabricksRootOptions.userName})
 * - strips trailing slashes (except `/`)
 *
 * For `~` without a known username, use {@link resolveDatabricksRoot}.
 */
export function normalizeDatabricksRoot(
  root: string,
  options: NormalizeDatabricksRootOptions = {},
): string {
  const trimmed = root.trim();
  if (!trimmed) {
    throw new TypeError("Databricks filesystem root cannot be empty");
  }

  if (isHomeRelativePath(trimmed)) {
    if (!options.userName?.trim()) {
      throw new TypeError(
        `Databricks home path "${root}" requires userName; use resolveDatabricksRoot() or pass userName`,
      );
    }
    return posixPath.normalizeRoot(expandHomePath(trimmed, options.userName));
  }

  const threePart = VOLUME_THREE_PART.exec(trimmed);
  if (threePart) {
    return posixPath.normalizeRoot(`/Volumes/${threePart[1]}/${threePart[2]}/${threePart[3]}`);
  }

  let posix = posixPath.toPosix(trimmed);
  if (posix === "/Volume" || posix.startsWith("/Volume/")) {
    posix = `/Volumes${posix.slice("/Volume".length)}`;
  }

  if (!posixPath.isAbsolute(posix)) {
    throw new TypeError(
      `Databricks filesystem root must be absolute, catalog.schema.volume, or ~, got: ${root}`,
    );
  }

  return posixPath.normalizeRoot(posix);
}

/**
 * Like {@link normalizeDatabricksRoot}, but resolves `~` via
 * {@link getCurrentUserName} (AppKit context user, else `currentUser.me()`).
 */
export async function resolveDatabricksRoot(
  root: string,
  options: ResolveDatabricksRootOptions = {},
): Promise<string> {
  if (!isHomeRelativePath(root)) {
    return normalizeDatabricksRoot(root);
  }
  const userName = await getCurrentUserName(options.client);
  return normalizeDatabricksRoot(root, { userName });
}

/** True when {@link absolutePath} is served by the workspace objects API. */
export function isWorkspaceFilesPath(absolutePath: string): boolean {
  const p = posixPath.toPosix(absolutePath);
  return (
    p === "/Workspace" ||
    p.startsWith("/Workspace/") ||
    p.startsWith("/Users/") ||
    p.startsWith("/Repos/") ||
    p.startsWith("/Shared/")
  );
}

/** True when {@link absolutePath} is a Unity Catalog volume path. */
export function isVolumesPath(absolutePath: string): boolean {
  const p = posixPath.toPosix(absolutePath);
  return p === "/Volumes" || p.startsWith("/Volumes/");
}

/** True when {@link absolutePath} is a DBFS path. */
export function isDbfsPath(absolutePath: string): boolean {
  const p = posixPath.toPosix(absolutePath);
  return p === "/dbfs" || p.startsWith("/dbfs/");
}

/**
 * Pick the Databricks API backend for an absolute path.
 *
 * Volume three-part roots are normalized before this runs, so callers should
 * pass paths from {@link normalizeDatabricksRoot} / {@link BaseFileSystem.resolvePath}.
 */
export function resolveDatabricksFilesBackend(absolutePath: string): DatabricksFilesBackend {
  if (isDbfsPath(absolutePath)) return "dbfs";
  if (isWorkspaceFilesPath(absolutePath)) return "workspace";
  if (isVolumesPath(absolutePath)) return "volumes";
  // Default: UC Files API (covers unusual absolute roots under the workspace host).
  return "volumes";
}
