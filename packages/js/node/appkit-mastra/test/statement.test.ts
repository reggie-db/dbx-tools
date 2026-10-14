import { describe, expect, test } from "bun:test";
import type { WorkspaceClient } from "@databricks/appkit";

import { fetchStatementEmbedData } from "../src/statement.ts";

describe("fetchStatementEmbedData", () => {
  test("projects one statement for sortable rows and AppKit Genie visualization", async () => {
    const client = {
      statementExecution: {
        getStatement: async () => ({
          manifest: {
            total_row_count: 2,
            schema: {
              columns: [
                { name: "week", type_name: "DATE" },
                { name: "sales", type_name: "DOUBLE" },
              ],
            },
          },
          result: {
            data_array: [
              ["2026-10-04", "42.5"],
              ["2026-10-11", "45.0"],
            ],
          },
        }),
      },
    } as unknown as WorkspaceClient;

    const result = await fetchStatementEmbedData(client, "statement-1", { limit: 1 });

    expect(result.data).toEqual({
      columns: ["week", "sales"],
      rows: [{ week: "2026-10-04", sales: 42.5 }],
      rowCount: 2,
    });
    expect(result.visualization).toEqual({
      manifest: {
        schema: {
          columns: [
            { name: "week", type_name: "DATE" },
            { name: "sales", type_name: "DOUBLE" },
          ],
        },
      },
      result: { data_array: [["2026-10-04", "42.5"]] },
    });
  });
});
