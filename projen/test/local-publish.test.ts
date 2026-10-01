import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localNodePublishArguments } from "../tasks/local-publish.ts";

describe("local release publication", () => {
  it("reuses the immediately preceding validated TypeScript compile", () => {
    assert.deepEqual(
      localNodePublishArguments(
        "/repo/tasks/publish.ts",
        { version: "1.2.3", reuseValidatedNodeCompile: true },
        "http://127.0.0.1:4873",
      ),
      ["/repo/tasks/publish.ts", "1.2.3", "--registry", "http://127.0.0.1:4873", "--skip-compile"],
    );
  });

  it("keeps standalone local publication self-compiling", () => {
    assert.deepEqual(
      localNodePublishArguments(
        "/repo/tasks/publish.ts",
        { version: "1.2.3" },
        "http://127.0.0.1:4873",
      ),
      ["/repo/tasks/publish.ts", "1.2.3", "--registry", "http://127.0.0.1:4873"],
    );
  });
});
