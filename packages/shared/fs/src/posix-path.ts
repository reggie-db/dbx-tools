/**
 * POSIX-only path helpers for {@link BaseFileSystem} and adapters.
 *
 * The portable filesystem namespace always uses `/` separators. Host adapters
 * convert with {@link toPosix} / {@link toHost} at the boundary; they must not
 * leak `\` into namespace paths.
 *
 * @module
 */

/** Replace every `\` with `/`. */
export function toPosix(input: string): string {
  return input.replace(/\\/g, "/");
}

/**
 * Convert a POSIX path to a host separator style.
 *
 * @param separator - Host separator (`path.sep` in Node). Defaults to `/`
 *   (no-op), which keeps shared code free of `process`.
 */
export function toHost(posixPath: string, separator = "/"): string {
  if (separator === "/" || separator.length === 0) return posixPath;
  // Preserve scheme roots such as `s3://bucket/key`.
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(posixPath);
  if (scheme) {
    const prefix = scheme[0];
    return prefix + posixPath.slice(prefix.length).replace(/\//g, separator);
  }
  return posixPath.replace(/\//g, separator);
}

/** True when {@link input} is an absolute POSIX or Windows-drive path. */
export function isAbsolute(input: string): boolean {
  const p = toPosix(input);
  if (p.startsWith("/")) return true;
  // `C:/...` drive path
  if (/^[A-Za-z]:\//.test(p)) return true;
  // `scheme://...`
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) return true;
  return false;
}

/**
 * Normalize a filesystem root for storage on {@link BaseFileSystem.root}.
 *
 * Converts to POSIX, trims, and strips trailing slashes while preserving
 * `/`, Windows drive roots (`C:/`), and URL-like scheme roots.
 */
export function normalizeRoot(root: string): string {
  const trimmed = toPosix(root.trim());
  if (!trimmed) {
    throw new TypeError("Filesystem root cannot be empty");
  }

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(.*)$/.exec(trimmed);
  if (scheme) {
    const [, prefix, rest] = scheme;
    if (!rest) return trimmed; // bare `s3://`
    return prefix + rest.replace(/\/+$/, "");
  }

  if (trimmed === "/") return "/";
  if (/^[A-Za-z]:\/$/.test(trimmed)) return trimmed;
  if (/^[A-Za-z]:\//.test(trimmed)) return trimmed.replace(/\/+$/, "");
  return trimmed.replace(/\/+$/, "");
}

/**
 * Join path segments using `/`.
 *
 * Absolute segments (see {@link isAbsolute}) reset the result. Empty segments
 * and `.` are skipped. Does not resolve `..`; use {@link normalize} for that.
 */
export function join(...parts: string[]): string {
  if (parts.length === 0) return ".";

  let result = "";
  for (const part of parts) {
    const segment = toPosix(part);
    if (!segment || segment === ".") continue;

    if (isAbsolute(segment)) {
      result = segment;
      continue;
    }

    if (!result || result.endsWith("/")) {
      result += segment.replace(/^\/+/, "");
    } else {
      result += `/${segment.replace(/^\/+/, "")}`;
    }
  }

  return result || ".";
}

export type NormalizeResult =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly escape: true };

/**
 * Normalize a filesystem-relative path into a rooted POSIX namespace path
 * (`/a/b`). Resolves `.` and `..`. Returns `{ escape: true }` when `..`
 * would leave the root.
 *
 * Backslashes are converted via {@link toPosix}. Null bytes are rejected by
 * callers that wrap this in a {@link FileSystemError}.
 */
export function normalize(inputPath: string): NormalizeResult {
  const p = toPosix(inputPath);
  const segments: string[] = [];

  for (const segment of p.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return { ok: false, escape: true };
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return { ok: true, path: `/${segments.join("/")}` };
}

/** Parent directory of a POSIX path (`/` for the root). */
export function dirname(inputPath: string): string {
  const p = toPosix(inputPath);
  if (p === "/" || /^[A-Za-z]:\/$/.test(p)) return p;

  const trimmed = p.replace(/\/+$/, "") || "/";
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0) {
    if (/^[A-Za-z]:\//.test(trimmed)) return `${trimmed.slice(0, 2)}/`;
    return "/";
  }
  if (slash === 2 && /^[A-Za-z]:\//.test(trimmed)) {
    return trimmed.slice(0, 3); // `C:/`
  }
  return trimmed.slice(0, slash) || "/";
}

/** Final segment of a POSIX path. */
export function basename(inputPath: string): string {
  const p = toPosix(inputPath).replace(/\/+$/, "");
  if (!p || p === "/") return "";
  const slash = p.lastIndexOf("/");
  return slash < 0 ? p : p.slice(slash + 1);
}

/**
 * Relative POSIX path from {@link from} to {@link to}, both absolute.
 * Returns undefined when {@link to} is outside {@link from}.
 */
export function relative(from: string, to: string): string | undefined {
  const fromNorm = normalizeRoot(from);
  const toNorm = toPosix(to).replace(/\/+$/, "") || toPosix(to);

  if (toNorm === fromNorm) return "";
  const prefix = fromNorm.endsWith("/") ? fromNorm : `${fromNorm}/`;
  if (!toNorm.startsWith(prefix) && toNorm !== fromNorm) {
    // Case-folding not applied; adapters that need it should normalize first.
    if (fromNorm === "/") {
      return toNorm.startsWith("/") ? toNorm.slice(1) : undefined;
    }
    return undefined;
  }
  return toNorm.slice(prefix.length);
}

/** Whether {@link candidate} is {@link root} or a descendant (POSIX lexical). */
export function isWithinRoot(root: string, candidate: string): boolean {
  return relative(root, candidate) !== undefined;
}

/** True when {@link input} is `~` or a path under `~/` (or `~\`). */
export function isHomeRelativePath(input: string): boolean {
  const trimmed = input.trim();
  return trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\");
}

/**
 * Expand a `~` / `~/...` input against {@link home}.
 *
 * Shared by every adapter that has a notion of "home", since each one differs
 * only in what `home` is and how segments join: local disk passes
 * `path.join`, Databricks passes a POSIX join under
 * `/Workspace/Users/<user>`. Non-home inputs come back trimmed and unchanged.
 *
 * @param joinWith - Join the expanded remainder onto {@link home}. Defaults to
 *   POSIX {@link join}.
 */
export function expandHome(
  input: string,
  home: string,
  joinWith: (home: string, rest: string) => string = join,
): string {
  const trimmed = input.trim();
  if (!isHomeRelativePath(trimmed)) return trimmed;
  if (!home.trim()) {
    throw new TypeError("Home expansion requires a non-empty home directory");
  }
  const rest = stripLeadingSeparators(trimmed.slice(1));
  return rest ? joinWith(home, rest) : home;
}

/**
 * Drop a leading `~` and any leading separators, so an absolute-looking or
 * home-relative input can be joined UNDER a base rather than replacing it.
 */
export function toRelativeSegment(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "." || trimmed === "./") return "";
  return stripLeadingSeparators(trimmed.replace(/^~(?=[/\\]|$)/, ""));
}

function stripLeadingSeparators(input: string): string {
  return input.replace(/^[\\/]+/, "");
}
