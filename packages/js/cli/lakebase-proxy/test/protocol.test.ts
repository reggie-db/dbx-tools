import { expect, test } from "bun:test";
import { startupComplete } from "../src/protocol.ts";

test("serializes a passwordless local startup completion", () => {
  const packet = startupComplete(new Map([["server_version", "17"]]), 42, 7);
  expect(packet[0]).toBe("R".charCodeAt(0));
  expect(packet.includes(Buffer.from("server_version\0"))).toBeTrue();
  expect(packet.at(-1)).toBe("I".charCodeAt(0));
});
