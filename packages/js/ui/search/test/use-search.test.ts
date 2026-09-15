import { describe, expect, it } from "bun:test";
import { parseUniversalSearchResult } from "../src/react/use-search.ts";

describe("parseUniversalSearchResult", () => {
  it("returns validated universal-search results", () => {
    expect(
      parseUniversalSearchResult({
        query: "lakebase",
        hits: [
          {
            id: "doc-1",
            score: 0.9,
            fields: { title: "Lakebase" },
            index: "catalog.schema.docs",
          },
        ],
        count: 1,
      }),
    ).toEqual({
      query: "lakebase",
      hits: [
        {
          id: "doc-1",
          score: 0.9,
          fields: { title: "Lakebase" },
          index: "catalog.schema.docs",
        },
      ],
      count: 1,
    });
  });

  it("rejects malformed responses before they reach UI state", () => {
    expect(() =>
      parseUniversalSearchResult({ query: "lakebase", hits: [{ score: "high" }], count: 1 }),
    ).toThrow();
  });
});
