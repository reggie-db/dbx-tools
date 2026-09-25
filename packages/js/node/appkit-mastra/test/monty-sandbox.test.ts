import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MontySandbox } from "../src/monty-sandbox.ts";

describe("MontySandbox", () => {
  it("executes Python source and returns prints plus the trailing value", async () => {
    const sandbox = new MontySandbox();

    const result = await sandbox.executeCommand("print('hello')\n21 * 2");

    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "hello\n42\n");
    assert.equal(result.stderr, "");
    assert.equal(sandbox.provider, "monty");
  });

  it("accepts the direct Python executable form", async () => {
    const sandbox = new MontySandbox();

    const result = await sandbox.executeCommand("python3", ["-c", "'ok'"]);

    assert.equal(result.success, true);
    assert.equal(result.stdout, "ok\n");
  });

  it("rejects shell and environment capabilities instead of pretending to support them", async () => {
    const sandbox = new MontySandbox();

    const shell = await sandbox.executeCommand("echo", ["hello"]);
    const environment = await sandbox.executeCommand("'ok'", [], {
      env: { SECRET: "hidden" },
    });

    assert.equal(shell.success, false);
    assert.match(shell.stderr, /accepts Python source/);
    assert.equal(environment.success, false);
    assert.match(environment.stderr, /does not expose host environment/);
  });

  it("bounds retained output while streaming every complete chunk", async () => {
    const sandbox = new MontySandbox();
    let streamed = "";

    const result = await sandbox.executeCommand("print('x' * 20)", [], {
      maxRetainedBytes: 8,
      onStdout: (text) => {
        streamed += text;
      },
    });

    assert.equal(streamed, `${"x".repeat(20)}\n`);
    assert.equal(new TextEncoder().encode(result.stdout).length, 8);
    assert.equal(result.stdout.endsWith("\n"), true);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stdoutDroppedBytes, 13);
  });

  it("aborts an in-flight worker instead of waiting for its execution limit", async () => {
    const sandbox = new MontySandbox();
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 20);

    await assert.rejects(
      () =>
        sandbox.executeCommand("while True:\n    pass", [], {
          abortSignal: controller.signal,
          timeout: 5_000,
        }),
      /cancelled/,
    );

    assert.ok(performance.now() - started < 1_000);
  });

  it("aborts while waiting for a worker without running the queued command", async () => {
    const sandbox = new MontySandbox();
    let readyCount = 0;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const blockers = Array.from({ length: 4 }, () =>
      sandbox.executeCommand("print('ready')\nwhile True:\n    pass", [], {
        timeout: 300,
        onStdout: (text) => {
          if (!text.includes("ready")) return;
          readyCount++;
          if (readyCount === 4) resolveReady();
        },
      }),
    );
    await ready;
    const controller = new AbortController();
    const started = performance.now();
    const queued = sandbox.executeCommand("'ran after abort'", [], {
      abortSignal: controller.signal,
      timeout: 5_000,
    });
    setTimeout(() => controller.abort(new DOMException("queued cancelled", "AbortError")), 20);

    await assert.rejects(() => queued, /queued cancelled/);

    assert.ok(performance.now() - started < 200);
    await Promise.all(blockers);
  });

  it("does not classify ordinary exception text as a timeout", async () => {
    const sandbox = new MontySandbox();

    const result = await sandbox.executeCommand("raise Exception('not a timeout')");

    assert.equal(result.success, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, undefined);
  });

  it("provides the no-op snapshot required by the workspace contract", async () => {
    const sandbox = new MontySandbox();

    await sandbox.snapshot();

    assert.equal(sandbox.supportsCheckpoints, false);
  });
});
