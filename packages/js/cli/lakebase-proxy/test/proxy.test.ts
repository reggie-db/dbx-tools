import { expect, test } from "bun:test";
import { LakebaseProxy } from "../src/proxy.ts";

test("binds to loopback and closes", async () => {
  const proxy = new LakebaseProxy({ host: "127.0.0.1", port: 0 });
  const address = await proxy.listen();
  expect(address.host).toBe("127.0.0.1");
  expect(address.port).toBeGreaterThan(0);
  await proxy.close();
});

test("rejects non-loopback listeners", async () => {
  const proxy = new LakebaseProxy({ host: "0.0.0.0", port: 0 });
  expect(proxy.listen()).rejects.toThrow("loopback");
});
