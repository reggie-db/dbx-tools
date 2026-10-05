import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  closeServiceControl,
  listenForServiceControl,
  requestServiceControl,
} from "../src/_control.ts";

describe("CLI service control socket", () => {
  it("preserves an active owner and rejects a second listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-control-"));
    const address = join(root, "service.sock");
    const first = await listenForServiceControl(
      address,
      () => ({ running: true, pid: 101 }),
      () => {},
    );

    assert.deepEqual(await requestServiceControl(address, "status"), {
      running: true,
      pid: 101,
    });
    await assert.rejects(
      () =>
        listenForServiceControl(
          address,
          () => ({ running: true, pid: 202 }),
          () => {},
        ),
      /already active/,
    );

    await closeServiceControl(first, address);
  });

  it("replaces a stale Unix socket path", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-control-"));
    const address = join(root, "service.sock");
    await writeFile(address, "stale", "utf8");

    const server = await listenForServiceControl(
      address,
      () => ({ running: true, pid: 303 }),
      () => {},
    );

    assert.equal((await requestServiceControl(address, "status"))?.pid, 303);
    await closeServiceControl(server, address);
  });

  it("flushes the stop response before invoking shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-control-"));
    const address = join(root, "service.sock");
    let stopped = false;
    const server = await listenForServiceControl(
      address,
      () => ({ running: true, pid: 404 }),
      () => {
        stopped = true;
      },
    );

    assert.equal((await requestServiceControl(address, "stop"))?.pid, 404);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, true);
    await closeServiceControl(server, address);
  });
});
