import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { githubRepositoryIdentity, githubTokenArguments } from "../src/release-github.ts";

describe("release GitHub identity", () => {
  it("keeps organization ownership separate from CLI authentication", () => {
    assert.deepEqual(githubRepositoryIdentity("https://github.com/example-org/tooling.git"), {
      hostname: "github.com",
      owner: "example-org",
      repository: "tooling",
    });
    assert.deepEqual(githubTokenArguments("github.com"), [
      "auth",
      "token",
      "--hostname",
      "github.com",
    ]);
  });

  it("preserves enterprise repository hosts", () => {
    assert.deepEqual(githubRepositoryIdentity("https://github.corp.example/collaborator/repo"), {
      hostname: "github.corp.example",
      owner: "collaborator",
      repository: "repo",
    });
  });
});
