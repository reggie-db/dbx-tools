/**
 * Mutable, Git-compatible `.gitignore` path matching.
 *
 * Rule syntax is owned by the `ignore` package, whose compatibility suite
 * compares behavior with `git check-ignore`. This module adds repository and
 * nested-file scoping plus in-memory add, update, and removal.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { glob, globSync, type IgnoreLike } from "glob";
import ignore from "ignore";
import type { IgnorePatternOptions } from "./ignore.ts";
import { ignorePathMatcher } from "./ignore.ts";
import { toPathMatcher, type PathMatcher } from "./match.ts";

interface GitIgnoreRuleSet {
  content: string;
  directory: string;
  matcher: ReturnType<typeof ignore>;
  path: string;
}

/** Options used while discovering `.gitignore` files beneath a root. */
export interface GitIgnoreLoadOptions {
  /** Built-in directory groups pruned while looking for ignore files. */
  ignoreOptions?: IgnorePatternOptions;
  /** Follow symlinked directories during discovery. Defaults to false. */
  followSymlinks?: boolean;
}

/** Mutable path predicate composed from root and nested `.gitignore` files. */
export class GitIgnore {
  readonly root: string;
  /** Stable composable matcher that observes later {@link set}, {@link delete}, and {@link clear} calls. */
  readonly matcher: PathMatcher = toPathMatcher((path) => this.ignores(path));

  private readonly files = new Map<string, GitIgnoreRuleSet>();
  private rules: GitIgnoreRuleSet[] = [];

  constructor(root: string | URL) {
    this.root = resolve(root instanceof URL ? fileURLToPath(root) : root);
  }

  /** Load every applicable `.gitignore` beneath {@link root}. */
  static async load(root: string | URL, options: GitIgnoreLoadOptions = {}): Promise<GitIgnore> {
    const result = new GitIgnore(root);
    for (const path of await glob("**/.gitignore", discoveryOptions(result.root, options))) {
      result.set(path, await readFile(resolve(result.root, path), "utf8"));
    }
    return result;
  }

  /** Synchronous counterpart to {@link GitIgnore.load}. */
  static loadSync(root: string | URL, options: GitIgnoreLoadOptions = {}): GitIgnore {
    const result = new GitIgnore(root);
    for (const path of globSync("**/.gitignore", discoveryOptions(result.root, options))) {
      result.set(path, readFileSync(resolve(result.root, path), "utf8"));
    }
    return result;
  }

  /** Whether `path` names a `.gitignore` control file. */
  static isFile(path: string): boolean {
    return basename(path) === ".gitignore";
  }

  /** Add or replace one `.gitignore` file and its in-memory content. */
  set(path: string, content: string): void {
    const relativePath = this.relativePath(path);
    if (!relativePath || !GitIgnore.isFile(relativePath)) {
      throw new TypeError(`Git ignore path must name a .gitignore under ${this.root}: ${path}`);
    }
    this.files.set(relativePath, {
      content,
      directory: toPosix(dirname(relativePath)) === "." ? "" : toPosix(dirname(relativePath)),
      matcher: ignore().add(content),
      path: relativePath,
    });
    this.refreshRules();
  }

  /** Remove one `.gitignore` file. Returns whether it was registered. */
  delete(path: string): boolean {
    const relativePath = this.relativePath(path);
    if (!relativePath) return false;
    const deleted = this.files.delete(relativePath);
    if (deleted) this.refreshRules();
    return deleted;
  }

  /** Remove every registered `.gitignore`. */
  clear(): void {
    this.files.clear();
    this.rules = [];
  }

  /** Return the retained content for a registered `.gitignore`. */
  get(path: string): string | undefined {
    const relativePath = this.relativePath(path);
    return relativePath ? this.files.get(relativePath)?.content : undefined;
  }

  /**
   * Synchronize the root and ancestor control files that can affect `path`.
   *
   * File watchers call this before evaluating a new filesystem event so a
   * control-file event delayed by the operating system cannot admit a file
   * under stale rules.
   */
  refreshPathSync(path: string): void {
    const relativePath = this.relativePath(path);
    if (!relativePath) return;
    const directory = toPosix(dirname(relativePath));
    const candidates = [".gitignore"];
    let current = "";
    for (const segment of directory === "." ? [] : directory.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      candidates.push(`${current}/.gitignore`);
    }
    for (const candidate of candidates) {
      const absolute = resolve(this.root, candidate);
      if (!existsSync(absolute)) {
        this.delete(candidate);
        continue;
      }
      const content = readFileSync(absolute, "utf8");
      if (this.get(candidate) !== content) this.set(candidate, content);
    }
  }

  /** Whether a path is ignored after applying parent then nested rule files. */
  ignores(path: string, directory: boolean = false): boolean {
    const relativePath = this.relativePath(path);
    if (!relativePath || relativePath === ".") return false;
    let ignored = false;
    for (const rules of this.rules) {
      const scopedPath = pathWithin(rules.directory, relativePath);
      if (scopedPath === undefined || scopedPath === "") continue;
      if (ignoredParent(rules.matcher, scopedPath)) return true;
      const result = rules.matcher.test(directory ? `${trimSlash(scopedPath)}/` : scopedPath);
      if (result.ignored) ignored = true;
      if (result.unignored) ignored = false;
    }
    return ignored;
  }

  private relativePath(path: string): string | undefined {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.root, path);
    const relativePath = relative(this.root, absolute);
    if (relativePath === "" || relativePath === ".") return ".";
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return undefined;
    }
    return toPosix(relativePath);
  }

  private refreshRules(): void {
    this.rules = [...this.files.values()].sort(
      (left, right) =>
        pathDepth(left.directory) - pathDepth(right.directory) ||
        left.path.localeCompare(right.path),
    );
  }
}

function discoveryOptions(
  root: string,
  options: GitIgnoreLoadOptions,
): {
  cwd: string;
  dot: true;
  follow: boolean;
  ignore: IgnoreLike;
  nodir: true;
} {
  const matcher = ignorePathMatcher(options.ignoreOptions);
  return {
    cwd: root,
    dot: true,
    follow: options.followSymlinks ?? false,
    ignore: {
      ignored(path) {
        const relativePath = path.relative();
        return !GitIgnore.isFile(relativePath) && matcher(relativePath);
      },
      childrenIgnored(path) {
        const relativePath = path.relative();
        return matcher(relativePath) || matcher(`${relativePath}/`);
      },
    },
    nodir: true,
  };
}

function ignoredParent(matcher: ReturnType<typeof ignore>, path: string): boolean {
  const segments = trimSlash(path).split("/");
  const parentCount = segments.length - 1;
  for (let index = 1; index <= parentCount; index++) {
    if (matcher.test(`${segments.slice(0, index).join("/")}/`).ignored) return true;
  }
  return false;
}

function pathWithin(directory: string, path: string): string | undefined {
  if (!directory) return path;
  if (path === directory) return "";
  return path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : undefined;
}

function pathDepth(path: string): number {
  return path ? path.split("/").length : 0;
}

function trimSlash(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
