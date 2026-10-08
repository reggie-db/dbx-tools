import { expect, test } from "bun:test";
import { CancellationRegistry } from "../src/lakebase-proxy/cancellation.ts";

test("maps synthetic cancellation keys to upstream keys", async () => {
  const forwarded: unknown[] = [];
  const registry = new CancellationRegistry(async (target) => {
    forwarded.push(target);
  });
  const target = { host: "database.example", port: 5432, processId: 12, secretKey: 34 };
  const local = registry.register(target);

  expect(local.processId).not.toBe(target.processId);
  expect(await registry.forward(local)).toBeTrue();
  expect(forwarded).toEqual([target]);

  registry.remove(local);
  expect(await registry.forward(local)).toBeFalse();
});
