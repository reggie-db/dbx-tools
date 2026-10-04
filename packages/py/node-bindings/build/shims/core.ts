import { coerce, gte } from "semver";

import { pythonHost } from "./host.ts";

interface BinVersionOutput {
  stdout: string;
  stderr: string;
}

function detectedVersion(output: string): string | undefined {
  const versions = [
    ...output.matchAll(/\bv?(\d+(?:\.\d+){0,2})(?:[-+._]?[a-z][0-9a-z.+_-]*)?/gi),
  ];
  return versions
    .map((match) => ({
      raw: match[0].replace(/^v/i, ""),
      parts: match[1]!.split(".").map(Number),
    }))
    .sort((left, right) => {
      if (left.parts.length !== right.parts.length) return right.parts.length - left.parts.length;
      for (let index = 0; index < left.parts.length; index += 1) {
        const difference = (right.parts[index] ?? 0) - (left.parts[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    })[0]?.raw;
}

function parseVersion({ stdout, stderr }: BinVersionOutput): string | undefined {
  return detectedVersion(stdout) ?? detectedVersion(stderr);
}

function isVersionAtLeast(version: string, minimum: string): boolean {
  const actualVersion = coerce(version, { loose: true });
  const minimumVersion = coerce(minimum, { loose: true });
  if (!minimumVersion) throw new TypeError(`invalid minimum binary version: ${minimum}`);
  return actualVersion ? gte(actualVersion, minimumVersion) : false;
}

export const bin = {
  parseVersion,
  isVersionAtLeast,
  async ensure(
    name: string,
    source: { url: string; sha256?: string },
    options: {
      destination: { root: string; binDir: string; path: string };
    },
  ) {
    await pythonHost().core.ensureBinary({
      name,
      url: source.url,
      sha256: source.sha256,
      destination: options.destination.path,
      executable: options.destination.path.split(/[\\/]/).at(-1) ?? name,
    });
    return options.destination;
  },
};

export const configUtils = {
  isDatabricksAppEnv(source: Record<string, string | undefined> = process.env): boolean {
    const override = source.DBX_TOOLS_DATABRICKS_APP_ENV?.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(override ?? "")) return true;
    if (["0", "false", "no", "off"].includes(override ?? "")) return false;
    const name = source.DATABRICKS_APP_NAME?.trim();
    const host = source.DATABRICKS_HOST?.trim();
    const port = source.DATABRICKS_APP_PORT?.trim();
    if (!name || /\$\{[^}]+\}/.test(name) || !host || !port || !/^\d+$/.test(port)) return false;
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) return false;
    try {
      const url = new URL(host);
      return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname);
    } catch {
      return false;
    }
  },
};

export const exec = {
  async spawn(
    command: string,
    args: string[],
    options: {
      env?: Record<string, string>;
      stdin?: string;
      signal?: AbortSignal;
    } = {},
  ) {
    if (options.signal?.aborted) throw new Error("Process execution was aborted");
    const result = await pythonHost().process.run(
      command,
      args,
      options.env,
      options.stdin && !["ignore", "inherit", "pipe"].includes(options.stdin)
        ? options.stdin
        : undefined,
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  },
};
