import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as pgaddress from "../src/pgaddress.ts";

describe("parseAddress", () => {
  it("returns no inputs for absent or unrecognized addresses", () => {
    for (const value of [null, "", "   ", "Not An Address"]) {
      assert.deepEqual(pgaddress.parseAddress(value), {});
    }
  });

  it("parses Postgres URIs and supported SSL modes", () => {
    assert.deepEqual(
      pgaddress.parseAddress(
        "postgresql://me%40acme.com@ep-1.database.eastus2.azuredatabricks.net:5433/app%20db?sslmode=disable",
      ),
      {
        host: "ep-1.database.eastus2.azuredatabricks.net",
        port: 5433,
        user: "me@acme.com",
        database: "app db",
        sslMode: "disable",
      },
    );
    assert.deepEqual(pgaddress.parseAddress("postgres://h.example.com/db?sslMode=PrEfEr"), {
      host: "h.example.com",
      database: "db",
      sslMode: "prefer",
    });
    assert.deepEqual(pgaddress.parseAddress("postgres://h.example.com/db?sslmode=verify-full"), {
      host: "h.example.com",
      database: "db",
    });
  });

  it("parses Lakebase resource paths", () => {
    assert.deepEqual(pgaddress.parseAddress("projects/demo/branches/production/endpoints/ep-1"), {
      project: "demo",
      branch: "production",
      endpointId: "ep-1",
      endpoint: "projects/demo/branches/production/endpoints/ep-1",
    });
    assert.deepEqual(
      pgaddress.parseAddress("projects/demo/branches/production/databases/databricks-postgres"),
      {
        project: "demo",
        branch: "production",
        databaseResourceId: "databricks-postgres",
      },
    );
    assert.deepEqual(pgaddress.parseAddress("projects/demo"), { project: "demo" });
    assert.deepEqual(pgaddress.parseAddress("projects/demo/branches/main"), {
      project: "demo",
      branch: "main",
    });
    assert.deepEqual(pgaddress.parseAddress("projects/demo/branches"), {});
  });

  it("parses a canonical resource path from a PostgreSQL URL", () => {
    assert.deepEqual(
      pgaddress.parseAddress(
        "postgresql://profile@localhost:5432/projects/demo/branches/production/endpoints/primary?sslmode=disable",
      ),
      {
        project: "demo",
        branch: "production",
        endpointId: "primary",
        endpoint: "projects/demo/branches/production/endpoints/primary",
        host: "localhost",
        port: 5432,
        user: "profile",
        sslMode: "disable",
      },
    );
  });

  it("recognizes hostnames and project ids", () => {
    assert.deepEqual(pgaddress.parseAddress("ep-1.database.azuredatabricks.net"), {
      host: "ep-1.database.azuredatabricks.net",
    });
    assert.deepEqual(pgaddress.parseAddress("dbx-tools-demo"), {
      project: "dbx-tools-demo",
    });
  });
});

describe("parseResourcePath", () => {
  it("accepts only complete resource paths", () => {
    assert.deepEqual(pgaddress.parseResourcePath("production"), {});
    assert.deepEqual(pgaddress.parseResourcePath(null), {});
    assert.deepEqual(pgaddress.parseResourcePath("projects/demo/branches/main"), {
      project: "demo",
      branch: "main",
    });
  });
});
