import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  mergeDataTableColumnOrder,
  readDataTableState,
} from "../src/table/react/data-table-state.ts";
import { DataTable, type ColumnDef } from "../src/table/react/data-table.tsx";

describe("DataTable", () => {
  it("renders generic columns and rows without lazy batching when requested", () => {
    const columns: ColumnDef<{ id: string; name: string; status: string }>[] = [
      { accessorKey: "name", header: "Name" },
      { accessorKey: "status", header: "Status" },
    ];
    const html = renderToStaticMarkup(
      createElement(DataTable, {
        id: "test",
        columns,
        data: [{ id: "one", name: "First", status: "Ready" }],
        getRowId: (row: { id: string }) => row.id,
        persistence: false,
        lazy: false,
      }),
    );

    assert.match(html, /aria-label="Data table"/);
    assert.match(html, />1 row</);
    assert.match(html, />Name</);
    assert.match(html, />First</);
    assert.match(html, />Ready</);
  });
});

describe("readDataTableState", () => {
  it("keeps valid persisted fields and rejects invalid field entries", () => {
    const storage = {
      getItem: () =>
        JSON.stringify({
          columnOrder: ["status", 4, "name"],
          columnSizing: { name: 260, broken: -1 },
          columnVisibility: { name: true, status: "yes" },
          sorting: [
            { id: "name", desc: false },
            { id: 4, desc: true },
          ],
          columnFilters: [{ id: "status", value: ["ready"] }, { value: "ignored" }],
        }),
    };

    assert.deepEqual(readDataTableState(storage, "table"), {
      columnFilters: [{ id: "status", value: ["ready"] }],
      columnOrder: ["status", "name"],
      columnSizing: { name: 260 },
      columnVisibility: { name: true },
      sorting: [{ id: "name", desc: false }],
    });
  });
});

describe("mergeDataTableColumnOrder", () => {
  it("drops removed columns and appends new columns", () => {
    assert.deepEqual(
      mergeDataTableColumnOrder(["status", "removed", "name"], ["name", "status", "added"]),
      ["status", "name", "added"],
    );
  });
});
