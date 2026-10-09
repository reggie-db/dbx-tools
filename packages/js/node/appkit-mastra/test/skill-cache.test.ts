import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { CacheManager } from "@databricks/appkit";
import {
  WorkspaceSkillCatalogue,
  workspaceSkillCatalogue,
  type SkillCatalogueFileEntry,
  type SkillCatalogueSource,
} from "../src/skill-cache.ts";

interface SourceFixture {
  counts: { lists: number; reads: number };
  fail: boolean;
  modifiedAt: number;
  present: boolean;
  source: SkillCatalogueSource;
}

function sourceFixture(id: string): SourceFixture {
  const fixture: SourceFixture = {
    counts: { lists: 0, reads: 0 },
    fail: false,
    modifiedAt: 1,
    present: true,
    source: undefined as never,
  };
  fixture.source = {
    id,
    async list(path): Promise<SkillCatalogueFileEntry[]> {
      fixture.counts.lists += 1;
      if (fixture.fail) throw new Error("workspace unavailable");
      if (path === ".") {
        return fixture.present ? [{ name: "databricks-apps", type: "directory" }] : [];
      }
      return [
        {
          name: "SKILL.md",
          type: "file",
          size: 100,
          metadata: { modifiedAt: fixture.modifiedAt },
        },
        { name: "references", type: "directory" },
      ];
    },
    async read(path): Promise<string> {
      fixture.counts.reads += 1;
      if (path.endsWith("SKILL.md")) {
        return [
          "---",
          "name: databricks-apps",
          "description: Build Databricks Apps",
          "---",
          `Instructions version ${fixture.modifiedAt}`,
        ].join("\n");
      }
      return `Reference content for ${path}`;
    },
  };
  return fixture;
}

function catalogue(fixture: SourceFixture, userKey = randomUUID()): WorkspaceSkillCatalogue {
  return new WorkspaceSkillCatalogue({
    host: "https://workspace.example.com",
    sources: [fixture.source],
    ttlMs: 60_000,
    userKey,
  });
}

describe("workspace skill catalogue cache", () => {
  it("coalesces concurrent discovery and serves warm turns without source reads", async () => {
    await CacheManager.getInstance();
    const fixture = sourceFixture(randomUUID());
    const owner = catalogue(fixture);

    const [first, second] = await Promise.all([owner.get(), owner.get()]);
    assert.deepEqual(first, second);
    assert.equal(first.skills[0]?.name, "databricks-apps");
    assert.deepEqual(fixture.counts, { lists: 2, reads: 1 });

    await owner.get();
    assert.deepEqual(fixture.counts, { lists: 2, reads: 1 });
  });

  it("isolates catalogue records by user", async () => {
    await CacheManager.getInstance();
    const fixture = sourceFixture(randomUUID());

    await catalogue(fixture, "user-one").get();
    await catalogue(fixture, "user-two").get();

    assert.deepEqual(fixture.counts, { lists: 4, reads: 2 });
  });

  it("reuses unchanged SKILL.md content and refreshes changed metadata", async () => {
    await CacheManager.getInstance();
    const fixture = sourceFixture(randomUUID());
    const owner = catalogue(fixture);

    await owner.get();
    await owner.invalidate();
    await owner.get();
    assert.deepEqual(fixture.counts, { lists: 4, reads: 1 });

    fixture.modifiedAt = 2;
    await owner.invalidate();
    const refreshed = await owner.get();
    assert.equal(refreshed.skills[0]?.instructions, "Instructions version 2");
    assert.deepEqual(fixture.counts, { lists: 6, reads: 2 });
  });

  it("retains the last valid catalogue when refresh fails", async () => {
    await CacheManager.getInstance();
    const fixture = sourceFixture(randomUUID());
    const owner = catalogue(fixture);
    const initial = await owner.get();

    fixture.fail = true;
    await owner.invalidate();

    assert.deepEqual(await owner.get(), initial);
  });

  it("removes deleted skills on refresh", async () => {
    await CacheManager.getInstance();
    const fixture = sourceFixture(randomUUID());
    const owner = catalogue(fixture);
    await owner.get();

    fixture.present = false;
    await owner.invalidate();

    assert.deepEqual((await owner.get()).skills, []);
  });

  it("reads auxiliary files only when explicitly requested", async () => {
    await CacheManager.getInstance();
    const fixture = sourceFixture(randomUUID());
    const owner = catalogue(fixture);
    await owner.get();
    assert.equal(fixture.counts.reads, 1);

    assert.equal(
      await owner.readSkillFile("databricks-apps", "references/deploy.md"),
      "Reference content for databricks-apps/references/deploy.md",
    );
    assert.equal(fixture.counts.reads, 2);
  });

  it("reuses a bounded stable owner for the same scope", () => {
    const fixture = sourceFixture(randomUUID());
    const options = {
      host: "https://workspace.example.com",
      sources: [fixture.source],
      userKey: randomUUID(),
    };

    assert.equal(workspaceSkillCatalogue(options), workspaceSkillCatalogue(options));
  });
});
