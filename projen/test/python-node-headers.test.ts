import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PythonHeaders } from "../shims/python-node/headers.ts";

describe("PythonHeaders", () => {
  it("supports the mutation and iteration used by Node HTTP clients", () => {
    const headers = new PythonHeaders({ Authorization: "Bearer secret" });
    headers.append("set-cookie", "first=1");
    headers.append("Set-Cookie", "second=2");
    headers.set("accept", "application/json");
    headers.delete("authorization");

    const visited: Record<string, string> = {};
    headers.forEach((value, name) => {
      visited[name] = value;
    });

    assert.equal(headers.has("Authorization"), false);
    assert.equal(headers.get("ACCEPT"), "application/json");
    assert.deepEqual(headers.getSetCookie(), ["first=1", "second=2"]);
    assert.deepEqual([...headers.keys()], ["set-cookie", "accept"]);
    assert.deepEqual([...headers.values()], ["first=1, second=2", "application/json"]);
    assert.deepEqual(visited, {
      "set-cookie": "first=1, second=2",
      accept: "application/json",
    });
  });
});
