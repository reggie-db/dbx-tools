import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { osPath } from "@dbx-tools/fs";

import {
  AITOOLS_SOURCE,
  normalizeRemoteSkillsOption,
  provisionRemoteSkills,
  type RemoteSkillsMetadata,
} from "../src/remote-skills.ts";

describe("normalizeRemoteSkillsOption", () => {
  it("returns undefined for missing / empty input", () => {
    assert.equal(normalizeRemoteSkillsOption(undefined), undefined);
    assert.equal(normalizeRemoteSkillsOption([]), undefined);
    assert.equal(normalizeRemoteSkillsOption({ sources: [] }), undefined);
  });

  it("wraps a bare source string into a single-source bag", () => {
    const normalized = normalizeRemoteSkillsOption("owner/repo");
    assert.deepEqual(normalized, { sources: ["owner/repo"] });
  });

  it("wraps an array of sources", () => {
    const normalized = normalizeRemoteSkillsOption(["owner/repo", "https://x/skill.md"]);
    assert.deepEqual(normalized?.sources, ["owner/repo", "https://x/skill.md"]);
  });

  it("wraps a lone RemoteSkillSourceOptions object", () => {
    const normalized = normalizeRemoteSkillsOption({ source: "owner/repo", failOnError: false });
    assert.deepEqual(normalized?.sources, [{ source: "owner/repo", failOnError: false }]);
  });

  it("passes a full options bag through, normalizing sources to an array", () => {
    const normalized = normalizeRemoteSkillsOption({
      sources: "owner/repo",
      failOnError: false,
      userEmail: "user@example.com",
    });
    assert.deepEqual(normalized, {
      sources: ["owner/repo"],
      failOnError: false,
      userEmail: "user@example.com",
    });
  });

  it("accepts URL-like sources alongside the aitools constant", () => {
    const url = new URL("https://example.com/SKILL.md");
    const normalized = normalizeRemoteSkillsOption([AITOOLS_SOURCE, url, { url: "https://x/y" }]);
    assert.deepEqual(normalized?.sources, [AITOOLS_SOURCE, url, { url: "https://x/y" }]);
  });

  it("exposes aitools as a plain constant callers can spell out", () => {
    assert.equal(AITOOLS_SOURCE, "aitools");
    assert.deepEqual(normalizeRemoteSkillsOption("aitools")?.sources, ["aitools"]);
  });
});

describe("provisionRemoteSkills failure policy", () => {
  it("returns an empty result for no configured sources", async () => {
    const result = await provisionRemoteSkills(undefined);
    assert.deepEqual(result, { localSkillPaths: [], skillNames: [] });
  });

  it("throws when a non-URL source can't resolve and failOnError defaults on", async () => {
    // No `skills` CLI is guaranteed here, and a bare shorthand isn't a URL, so
    // the fetch fallback rejects. With failOnError defaulting to true, startup
    // provisioning should throw and name the offending source.
    await assert.rejects(
      () =>
        provisionRemoteSkills({ sources: ["definitely-not-a-url-shorthand"], client: undefined }),
      /definitely-not-a-url-shorthand/,
    );
  });

  it("skips an unresolvable source when failOnError is false", async () => {
    const result = await provisionRemoteSkills({
      sources: ["definitely-not-a-url-shorthand"],
      failOnError: false,
      client: undefined,
    });
    assert.deepEqual(result.localSkillPaths, []);
    assert.deepEqual(result.skillNames, []);
  });
});

/**
 * Provisioning runs at app BOOT, so the thing worth pinning is that a restart
 * does NOT re-download.
 *
 * The source is a local server, and it answers BOTH ways a source can be
 * staged: the `.well-known` index the optional `skills` CLI discovers through,
 * and a plain body for the fetch fallback used when that peer dep is absent.
 * Which one runs is a property of the environment, not of the cache, so the
 * assertions count only requests for skill CONTENT and compare skill names
 * against the first call rather than hard-coding them.
 */
describe("remote skill caching", () => {
  let server: Server;
  let source: string;
  let temp: string;
  let previousTmpdir: string | undefined;

  /** The `skills` CLI v1 discovery document, pointing at the one skill below. */
  const wellKnownIndex = JSON.stringify({
    skills: [{ name: "demo-skill", description: "A skill served for tests", files: ["SKILL.md"] }],
  });

  /** Frontmatter included because the CLI rejects a `SKILL.md` without it. */
  const skillBody =
    "---\nname: demo-skill\ndescription: A skill served for tests\n---\n\n# Cached skill\n";

  before(async () => {
    server = createServer((req, res) => {
      if (req.url?.endsWith("/index.json")) {
        if (!req.url.includes("agent-skills")) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(wellKnownIndex);
        return;
      }
      res.writeHead(200, { "content-type": "text/markdown" }).end(skillBody);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    source = `http://127.0.0.1:${port}`;

    // The provisioned tree lives under the OS temp root, which persists between
    // runs - exactly what makes the cache useful, and what would otherwise let
    // a previous run's tree decide this one's first assertion.
    temp = mkdtempSync(join(tmpdir(), "remote-skills-cache-"));
    previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = temp;
    osPath.clearOsPathsCache();
  });

  after(async () => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    osPath.clearOsPathsCache();
    rmSync(temp, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  /** The metadata document written at the root of a provisioned tree. */
  const metadataAt = (root: string): RemoteSkillsMetadata =>
    JSON.parse(readFileSync(join(root, ".metadata.json"), "utf8"));

  /**
   * When the tree at `root` was last downloaded.
   *
   * This is the signal the cases assert on rather than a count of requests to
   * the server: the `skills` CLI keeps a download cache of its own, so a server
   * that sees no request proves nothing about whether OUR cache was consulted.
   * The timestamp only moves when provisioning actually re-ran.
   */
  const downloadedAt = (root: string): string =>
    Object.values(metadataAt(root).sources)[0]!.downloadedAt;

  /** What the first boot produced, for the later cases to compare against. */
  let first: Awaited<ReturnType<typeof provisionRemoteSkills>>;

  it("downloads a source and records when it did", async () => {
    first = await provisionRemoteSkills({ sources: [source], client: undefined });
    assert.equal(first.localSkillPaths.length, 1);
    assert.ok(first.skillNames.length > 0);

    const [entry] = Object.values(metadataAt(first.localSkillPaths[0]!).sources);
    assert.equal(entry?.source, source);
    assert.deepEqual(entry?.skills, first.skillNames);
    // Recent enough that a restart within the window reuses it.
    assert.ok(Date.now() - Date.parse(entry!.downloadedAt) < 60_000);
  });

  it("reuses the provisioned tree on the next boot instead of downloading again", async () => {
    const before = downloadedAt(first.localSkillPaths[0]!);
    const result = await provisionRemoteSkills({ sources: [source], client: undefined });

    assert.equal(downloadedAt(first.localSkillPaths[0]!), before, "nothing re-provisioned");
    // A cache hit still has to report what a download would have, or the agent
    // silently loses the skills it had on the previous boot.
    assert.deepEqual(result.skillNames, first.skillNames);
    assert.deepEqual(result.localSkillPaths, first.localSkillPaths);
  });

  it("downloads again once the recorded timestamp falls outside the window", async () => {
    const root = first.localSkillPaths[0]!;
    const metadata = metadataAt(root);
    const aged = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    for (const entry of Object.values(metadata.sources)) entry.downloadedAt = aged;
    writeFileSync(join(root, ".metadata.json"), JSON.stringify(metadata, null, 2));

    const result = await provisionRemoteSkills({ sources: [source], client: undefined });
    assert.notEqual(downloadedAt(root), aged, "a day-old record is stale");
    assert.deepEqual(result.skillNames, first.skillNames);
  });

  it("honors refreshTtlMs: 0 as download on every boot", async () => {
    const root = first.localSkillPaths[0]!;
    const before = downloadedAt(root);
    await provisionRemoteSkills({ sources: [source], client: undefined, refreshTtlMs: 0 });
    const between = downloadedAt(root);
    assert.notEqual(between, before);

    await provisionRemoteSkills({ sources: [{ source, refreshTtlMs: 0 }], client: undefined });
    assert.notEqual(downloadedAt(root), between, "the per-source override applies too");
  });

  it("treats a changed skill selection as a different source", async () => {
    // The selection changes what a download CONTAINS, so it belongs in the
    // cache key - otherwise a narrowed or widened `skills` list would read back
    // the previous, differently-scoped tree for a day.
    const result = await provisionRemoteSkills({
      sources: [{ source, skills: ["demo-skill"] }],
      client: undefined,
    });
    assert.notDeepEqual(result.localSkillPaths, first.localSkillPaths, "its own tree");

    const [entry] = Object.values(metadataAt(result.localSkillPaths[0]!).sources);
    assert.deepEqual(entry?.policy, { skills: ["demo-skill"] });
  });

  it("re-downloads rather than failing when the record is corrupt", async () => {
    const root = first.localSkillPaths[0]!;
    writeFileSync(join(root, ".metadata.json"), "{ not json");

    const result = await provisionRemoteSkills({ sources: [source], client: undefined });
    assert.ok(
      Date.now() - Date.parse(downloadedAt(root)) < 60_000,
      "an unreadable record is a miss, not a startup failure",
    );
    assert.deepEqual(result.skillNames, first.skillNames);
  });
});
