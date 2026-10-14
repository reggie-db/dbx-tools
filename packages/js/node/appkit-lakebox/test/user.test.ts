import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isLakeboxUserHash,
  LAKEBOX_PORT_COUNT,
  LAKEBOX_PORT_MIN,
  LAKEBOX_UID_COUNT,
  LAKEBOX_UID_MIN,
  lakeboxPersistentHome,
  lakeboxServicePort,
  lakeboxUser,
} from "../src/user.ts";

describe("lakeboxUser", () => {
  it("derives every user value from one normalized identity hash", () => {
    const user = lakeboxUser(" Person@Example.com ", "/lakebox/");
    assert.deepEqual(lakeboxUser("person@example.com", "/lakebox"), user);
    assert.ok(isLakeboxUserHash(user.hash));
    assert.equal(user.name, `lakebox-${user.hash}`);
    assert.equal(user.home, `/home/${user.name}`);
    assert.equal(user.routePrefix, `/lakebox/${user.hash}`);
    assert.ok(user.uid >= LAKEBOX_UID_MIN && user.uid < LAKEBOX_UID_MIN + LAKEBOX_UID_COUNT);
    assert.ok(user.uid < 65_536, "the persistent idmapped volume stores UIDs below 65536");
    assert.equal(
      lakeboxPersistentHome(user.hash),
      `/home/sandbox-agent/.dbx-tools/users/${user.hash}`,
    );
  });

  it("separates users and rejects empty identities", () => {
    assert.notEqual(
      lakeboxUser("a@example.com", "/l").hash,
      lakeboxUser("b@example.com", "/l").hash,
    );
    assert.throws(() => lakeboxUser("  ", "/l"), /authenticated identity/);
  });

  it("derives stable service ports inside the reserved range", () => {
    const { hash } = lakeboxUser("a@example.com", "/l");
    const port = lakeboxServicePort(hash, "terminal");
    assert.equal(lakeboxServicePort(hash, "terminal"), port);
    assert.notEqual(lakeboxServicePort(hash, "desktop"), port);
    assert.ok(port >= LAKEBOX_PORT_MIN && port < LAKEBOX_PORT_MIN + LAKEBOX_PORT_COUNT);
    assert.ok(port + 1 < 32_768, "service ports stay below the kernel ephemeral range");
  });
});
