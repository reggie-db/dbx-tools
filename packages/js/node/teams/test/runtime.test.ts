import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TeamsPlugin } from "../src/plugin.ts";
import type { TeamsExecutor } from "../src/runtime.ts";

function installExecutor(plugin: TeamsPlugin, owner: string, calls: string[]): void {
  const execute: TeamsExecutor = async (fn) => {
    calls.push(owner);
    try {
      return { ok: true, data: await fn() };
    } catch (cause) {
      return {
        ok: false,
        status: 500,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  };
  Object.assign(plugin as object, { execute });
}

describe("Teams plugin runtime ownership", () => {
  it("isolates card config and executors across plugin shutdown", async () => {
    const calls: string[] = [];
    const first = new TeamsPlugin({ cardVersion: "1.4" });
    const second = new TeamsPlugin({ cardVersion: "1.5" });
    installExecutor(first, "first", calls);
    installExecutor(second, "second", calls);

    const firstCard = await first.exports().buildCard({ title: "First" });
    const secondCard = await second.exports().buildCard({ title: "Second" });
    assert.equal(firstCard.card.version, "1.4");
    assert.equal(secondCard.card.version, "1.5");

    first.shutdown();
    const afterShutdown = await second.exports().buildCard({ title: "Still active" });
    assert.equal(afterShutdown.card.version, "1.5");
    assert.deepEqual(calls, ["first", "second", "second"]);
  });
});
