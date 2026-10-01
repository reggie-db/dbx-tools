import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  githubAuthenticatedAccounts,
  githubRepositoryApiPath,
  githubRepositoryIdentity,
  githubRepositorySpecifier,
  githubTokenArguments,
  githubTokenEnvironmentName,
} from "../src/release-github.ts";

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
    assert.deepEqual(githubTokenArguments("github.com", "release-user"), [
      "auth",
      "token",
      "--hostname",
      "github.com",
      "--user",
      "release-user",
    ]);
    assert.equal(
      githubRepositoryApiPath({
        hostname: "github.com",
        owner: "example-org",
        repository: "tooling",
      }),
      "repos/example-org/tooling",
    );
  });

  it("orders successful authenticated accounts without assuming the repository owner", () => {
    assert.deepEqual(
      githubAuthenticatedAccounts(
        JSON.stringify({
          hosts: {
            "github.com": [
              { state: "success", active: false, login: "write-user" },
              { state: "failed", active: false, login: "expired-user" },
              { state: "success", active: true, login: "active-user" },
              { state: "success", active: false, login: "write-user" },
            ],
          },
        }),
        "github.com",
      ),
      [
        { login: "active-user", active: true },
        { login: "write-user", active: false },
      ],
    );
  });

  it("preserves enterprise repository hosts", () => {
    const identity = githubRepositoryIdentity("https://github.corp.example/collaborator/repo");
    assert.deepEqual(identity, {
      hostname: "github.corp.example",
      owner: "collaborator",
      repository: "repo",
    });
    assert.equal(githubRepositorySpecifier(identity), "github.corp.example/collaborator/repo");
    assert.equal(githubTokenEnvironmentName("github.corp.example"), "GH_ENTERPRISE_TOKEN");
    assert.equal(githubTokenEnvironmentName("tenant.ghe.com"), "GH_TOKEN");
  });
});
