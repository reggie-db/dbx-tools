import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAddress, parseResourcePath, SSL_MODES } from "../src/pgaddress";

describe("pgaddress parseAddress", () => {
  it("returns nothing for empty and unrecognized input", () => {
    assert.deepEqual(parseAddress(undefined), {});
    assert.deepEqual(parseAddress(""), {});
    assert.deepEqual(parseAddress("   "), {});
    assert.deepEqual(parseAddress("Not An Address"), {});
  });

  it("splits a Postgres URI into host, user, database, port and ssl mode", () => {
    const parsed = parseAddress(
      "postgresql://me%40acme.com@ep-1.database.eastus2.azuredatabricks.net:5433/app?sslmode=disable",
    );
    assert.equal(parsed.host, "ep-1.database.eastus2.azuredatabricks.net");
    assert.equal(parsed.user, "me@acme.com");
    assert.equal(parsed.database, "app");
    assert.equal(parsed.port, 5433);
    assert.equal(parsed.sslMode, "disable");
  });

  it("ignores an ssl mode the driver does not accept", () => {
    assert.equal(
      parseAddress("postgres://h.example.com/db?sslmode=verify-full").sslMode,
      undefined,
    );
    assert.deepEqual([...SSL_MODES], ["require", "disable", "prefer"]);
  });

  it("recovers project, branch and endpoint from a canonical endpoint path", () => {
    const path = "projects/demo/branches/production/endpoints/ep-1";
    assert.deepEqual(parseAddress(path), {
      project: "demo",
      branch: "production",
      endpointId: "ep-1",
      endpoint: path,
    });
  });

  it("keeps a database resource id separate from PGDATABASE", () => {
    assert.deepEqual(
      parseAddress("projects/demo/branches/production/databases/databricks-postgres"),
      {
        project: "demo",
        branch: "production",
        databaseResourceId: "databricks-postgres",
      },
    );
  });

  it("reads shorter resource paths", () => {
    assert.deepEqual(parseAddress("projects/demo"), { project: "demo" });
    assert.deepEqual(parseAddress("projects/demo/branches/main"), {
      project: "demo",
      branch: "main",
    });
    assert.deepEqual(parseAddress("projects/demo/branches"), {});
  });

  it("treats a dotted value as a hostname and a bare slug as a project id", () => {
    assert.deepEqual(parseAddress("ep-1.database.azuredatabricks.net"), {
      host: "ep-1.database.azuredatabricks.net",
    });
    assert.deepEqual(parseAddress("dbx-tools-demo"), { project: "dbx-tools-demo" });
  });
});

describe("pgaddress parseResourcePath", () => {
  it("only accepts `projects/` paths so a bare branch id is not read as a project", () => {
    assert.deepEqual(parseResourcePath("production"), {});
    assert.deepEqual(parseResourcePath(undefined), {});
    assert.equal(parseResourcePath("projects/demo/branches/main").branch, "main");
  });
});
