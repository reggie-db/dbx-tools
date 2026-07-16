import { Stats, statSync } from "node:fs";
import { spawnSync, SyncExecOptions } from "./exec";
import { memoize } from "./function";
import { OneOrMany } from "./iterable";
import { dirname, join, resolve } from "node:path";


const ROOT_MARKERS = [
    ".projenrc.ts",
    ".projenrc.js",
    ".projenrc.mjs",
    ".projenrc.cjs",
    "package.json",
] as const;

function statPath(path: string): Stats | undefined {
    if (path) {
        try { return statSync(path) } catch { }
    }
    return undefined;
}


function directoryCommand(command: string, args: string[], options?: SyncExecOptions): string | undefined {
    const normalizedOptions: SyncExecOptions = {
        ...options,
        stdin: "ignore",
        stderr: "ignore",
        stdout: "capture",
        check: false,
        trim: true,
    }
    const output = spawnSync(...[command, ...args, normalizedOptions]).stdout;
    return statPath(output)?.isDirectory() ? output : undefined;
}

const rootDirectoryCommands: Record<string, [string, string[]]> = {
    npm: ["npm", ["prefix"]] as const,
    git: ["git", ["rev-parse", "--show-toplevel"]] as const,
} as const;


const rootDirectoryDefaultCache = new Map<keyof typeof rootDirectoryCommands, { cwd: string, path?: string }>();

function rootDirectory(name: keyof typeof rootDirectoryCommands, cwd?: string): string | undefined {
    const [command, args] = rootDirectoryCommands[name];
    let cache: boolean
    if (cwd === undefined) {
        cwd = process.cwd();
        cache = true;
    } else {
        cache = cwd === process.cwd();
    }
    if (cache) {
        const cached = rootDirectoryDefaultCache.get(name);
        if (cached?.cwd === cwd) {
            return cached!.path;
        }
    }
    const path = directoryCommand(command, args, { cwd });
    if (cache) {
        rootDirectoryDefaultCache.set(name, { cwd, path });
    }
    return path;
}
function npmRoot(cwd?: string): string | undefined {
    return rootDirectory("npm", cwd);
}

function gitRoot(cwd?: string): string | undefined {
    return rootDirectory("git", cwd);
}

export function root(cwd: string = process.cwd()): string | undefined {
    let current = resolve(cwd);

    if (!statPath(current)?.isDirectory()) {
        current = dirname(current);
    }
    const boundaries = new Set(
        [npmRoot(cwd), gitRoot(cwd)]
            .filter((path): path is string => path !== undefined)
            .map((path) => resolve(path)),
    );
    const hasBoundary = boundaries.size > 0;
    let best: { dir: string; priority: number } | undefined;
    while (true) {
        for (const [priority, marker] of ROOT_MARKERS.entries()) {
            if (statPath(join(current, marker))?.isFile()) {
                if (
                    best === undefined ||
                    priority < best.priority ||
                    (priority === best.priority && current.length < best.dir.length)
                ) {
                    best = { dir: current, priority };
                }
                break;
            }
        }
        if (!hasBoundary && best) {
            return best.dir;
        }
        if (boundaries.has(current)) {
            return best?.dir;
        }
        const parent = dirname(current);
        if (parent === current) {
            return best?.dir;
        }
        current = parent;
    }
}

if (import.meta.main) {
    console.log("npm root:", npmRoot());
    console.log("repo root:", gitRoot());
    console.log("package root:", root());
    console.log("npm root:", npmRoot());
    console.log("repo root:", gitRoot());
}
