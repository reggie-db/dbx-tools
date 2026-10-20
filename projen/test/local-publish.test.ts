import assert from "node:assert/strict";
import { basename, dirname } from "node:path";
import { describe, it } from "node:test";
import type { ChildProcessResult } from "@dbx-tools/core/exec";
import {
  awaitLocalPublishers,
  localPublishTaskPath,
  resolveLocalRegistry,
} from "../tasks/local-publish.ts";

describe("local release publication", () => {
  it("disables local npm publication explicitly", () => {
    assert.equal(resolveLocalRegistry("false"), undefined);
    assert.equal(resolveLocalRegistry(""), undefined);
  });

  it("keeps an explicit local npm registry unchanged", () => {
    assert.equal(resolveLocalRegistry("http://127.0.0.1:4873"), "http://127.0.0.1:4873");
  });

  it("resolves flattened publish tasks as siblings", () => {
    const npm = localPublishTaskPath("publish.ts");
    const python = localPublishTaskPath("publish-python.ts");
    assert.equal(dirname(npm), dirname(python));
    assert.equal(basename(npm), "publish.ts");
    assert.equal(basename(python), "publish-python.ts");
  });

  it("terminates a live sibling when another publisher fails", async () => {
    let shutdownCalled = false;
    let finishSibling: (() => void) | undefined;
    const sibling = Object.assign(
      new Promise<void>((resolve) => {
        finishSibling = resolve;
      }),
      {
        exitCode: null,
        signalCode: null,
        shutdown: async () => {
          shutdownCalled = true;
          finishSibling?.();
        },
      },
    ) as unknown as ChildProcessResult;
    const failed = Object.assign(Promise.reject(new Error("npm publish failed")), {
      exitCode: 1,
      signalCode: null,
      shutdown: async () => {},
    }) as unknown as ChildProcessResult;

    await assert.rejects(awaitLocalPublishers([failed, sibling]), /npm publish failed/);
    assert.equal(shutdownCalled, true);
  });
});
