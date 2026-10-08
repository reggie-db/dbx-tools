import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { CacheManager } from "@databricks/appkit";
import { MemoryFileSystem } from "@dbx-tools/shared-fs";
import type { FileEntry, ListOptions } from "@dbx-tools/shared-fs";

import {
  AppKitCachedFileSystem,
  cachedWorkspaceSkillMount,
  clearWorkspaceSkillCache,
} from "../src/skill-cache.ts";

class CountingMemoryFileSystem extends MemoryFileSystem {
  readdirCalls = 0;
  waitForRead: Promise<void> | undefined;

  override async readdir(inputPath: string, options?: ListOptions): Promise<FileEntry[]> {
    this.readdirCalls += 1;
    await this.waitForRead;
    return super.readdir(inputPath, options);
  }
}

async function source(root: string): Promise<CountingMemoryFileSystem> {
  const filesystem = new CountingMemoryFileSystem({ root });
  await filesystem.init();
  await filesystem.writeFile("SKILL.md", "# Skill\n");
  return filesystem;
}

describe("AppKit workspace skill cache", () => {
  it("coalesces concurrent reads and isolates Mastra-resolved user ids", async () => {
    await CacheManager.getInstance();
    const root = `/skills-${randomUUID()}`;
    const filesystem = await source(root);
    let release!: () => void;
    filesystem.waitForRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstUser = new AppKitCachedFileSystem({
      host: "https://workspace.example.com",
      source: filesystem,
      userKey: "mastra-user-1",
    });

    const first = firstUser.readdir(".");
    const second = firstUser.readdir(".");
    await Promise.resolve();
    release();
    assert.deepEqual(await first, await second);
    assert.equal(filesystem.readdirCalls, 1);

    await firstUser.readdir(".");
    assert.equal(filesystem.readdirCalls, 1);

    const secondUser = new AppKitCachedFileSystem({
      host: "https://workspace.example.com",
      source: filesystem,
      userKey: "mastra-user-2",
    });
    await secondUser.readdir(".");
    assert.equal(filesystem.readdirCalls, 2);
  });

  it("invalidates cached reads after a mutation", async () => {
    await CacheManager.getInstance();
    const filesystem = await source(`/skills-${randomUUID()}`);
    const cached = new AppKitCachedFileSystem({
      host: "https://workspace.example.com",
      source: filesystem,
      userKey: "mastra-user",
    });

    assert.equal((await cached.readdir(".")).length, 1);
    assert.equal(filesystem.readdirCalls, 1);
    await cached.writeFile("reference.md", "reference");
    assert.equal((await cached.readdir(".")).length, 2);
    assert.equal(filesystem.readdirCalls, 2);
  });

  it("retains stable mount identity when its AppKit entries are cleared", async () => {
    await CacheManager.getInstance();
    const root = `/skills-${randomUUID()}`;
    const firstSource = await source(root);
    const secondSource = await source(root);
    const options = {
      host: "https://workspace.example.com",
      source: firstSource,
      userKey: "mastra-user",
    };

    const first = cachedWorkspaceSkillMount(options);
    const second = cachedWorkspaceSkillMount({
      ...options,
      source: secondSource,
    });
    const otherUser = cachedWorkspaceSkillMount({
      ...options,
      userKey: "other-user",
    });

    assert.equal(first.filesystem, second.filesystem);
    assert.notEqual(first.filesystem, otherUser.filesystem);

    await clearWorkspaceSkillCache({
      host: options.host,
      root,
      userKey: options.userKey,
    });
    const refreshed = cachedWorkspaceSkillMount(options);
    assert.equal(first.filesystem, refreshed.filesystem);
  });
});
