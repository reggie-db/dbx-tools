import { expect, test } from "bun:test";
import { LakebaseProxy } from "../src/proxy.ts";

test("binds to loopback and closes", async () => {
  const proxy = new LakebaseProxy({ listen: "127.0.0.1:0" });
  const address = await proxy.listen();
  expect(address.host).toBe("127.0.0.1");
  expect(address.port).toBeGreaterThan(0);
  await proxy.close();
});

test("rejects non-loopback listeners", () => {
  expect(() => new LakebaseProxy({ listen: "0.0.0.0:5432" })).toThrow("loopback");
});
