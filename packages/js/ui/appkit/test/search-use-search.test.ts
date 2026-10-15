import { describe, expect, it } from "bun:test";
import {
  parseUniversalSearchResult,
  usesUniversalSearchRoute,
} from "../src/search/react/use-search.ts";

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

describe("usesUniversalSearchRoute", () => {
  it("uses the native query path when one index is the complete search set", () => {
    expect(usesUniversalSearchRoute(true, 1)).toBe(false);
  });

  it("keeps the federated route for zero or multiple configured indexes", () => {
    expect(usesUniversalSearchRoute(true, 0)).toBe(true);
    expect(usesUniversalSearchRoute(true, 2)).toBe(true);
    expect(usesUniversalSearchRoute(false, 2)).toBe(false);
  });
});
