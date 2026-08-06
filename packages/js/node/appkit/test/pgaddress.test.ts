import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Language, polygotTest } from "@dbx-tools/test-polyglot/polyglot";

await polygotTest(
  () => import("../index.ts"),
  "pgaddress",
  (implementation, language) => {
    describe(`parseAddress (${language})`, () => {
      it("returns no inputs for absent or unrecognized addresses", () => {
        for (const value of [null, "", "   ", "Not An Address"]) {
          assert.deepEqual(implementation.parseAddress(value), {});
        }
      });

      it("parses Postgres URIs and supported SSL modes", () => {
        assert.deepEqual(
          implementation.parseAddress(
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
        assert.deepEqual(
          implementation.parseAddress("postgres://h.example.com/db?sslMode=PrEfEr"),
          { host: "h.example.com", database: "db", sslMode: "prefer" },
        );
        assert.deepEqual(
          implementation.parseAddress("postgres://h.example.com/db?sslmode=verify-full"),
          { host: "h.example.com", database: "db" },
        );
      });

      it("parses Lakebase resource paths", () => {
        assert.deepEqual(
          implementation.parseAddress("projects/demo/branches/production/endpoints/ep-1"),
          {
            project: "demo",
            branch: "production",
            endpointId: "ep-1",
            endpoint: "projects/demo/branches/production/endpoints/ep-1",
          },
        );
        assert.deepEqual(
          implementation.parseAddress(
            "projects/demo/branches/production/databases/databricks-postgres",
          ),
          {
            project: "demo",
            branch: "production",
            databaseResourceId: "databricks-postgres",
          },
        );
        assert.deepEqual(implementation.parseAddress("projects/demo"), { project: "demo" });
        assert.deepEqual(implementation.parseAddress("projects/demo/branches/main"), {
          project: "demo",
          branch: "main",
        });
        assert.deepEqual(implementation.parseAddress("projects/demo/branches"), {});
      });

      it("recognizes hostnames and project ids", () => {
        assert.deepEqual(implementation.parseAddress("ep-1.database.azuredatabricks.net"), {
          host: "ep-1.database.azuredatabricks.net",
        });
        assert.deepEqual(implementation.parseAddress("dbx-tools-demo"), {
          project: "dbx-tools-demo",
        });
      });
    });

    describe(`parseResourcePath (${language})`, () => {
      it("accepts only complete resource paths", () => {
        assert.deepEqual(implementation.parseResourcePath("production"), {});
        assert.deepEqual(implementation.parseResourcePath(null), {});
        assert.deepEqual(implementation.parseResourcePath("projects/demo/branches/main"), {
          project: "demo",
          branch: "main",
        });
      });
    });
  },
  { identifiers: { [Language.Python]: "dbx_tools.postgres.address" } },
);
