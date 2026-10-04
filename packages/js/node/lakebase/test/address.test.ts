import { describe, expect, test } from "bun:test";
import { connectionUrl, parseAddress, parseResourcePath } from "../src/address.ts";

describe("Lakebase address parsing", () => {
  test("parses PostgreSQL URLs", () => {
    expect(
      parseAddress(
        "postgresql://me%40example.com@ep.database.example.com:5433/app?sslmode=disable",
      ),
    ).toEqual({
      user: "me@example.com",
      host: "ep.database.example.com",
      port: 5433,
      database: "app",
      sslMode: "disable",
    });
  });

  test("parses canonical resource paths", () => {
    expect(
      parseResourcePath("projects/demo/branches/production/endpoints/primary"),
    ).toEqual({
      project: "demo",
      branch: "production",
      endpoint: "projects/demo/branches/production/endpoints/primary",
      endpointId: "primary",
    });
  });

  test("formats local proxy URLs", () => {
    expect(connectionUrl("projects/demo", "127.0.0.1", 5432)).toBe(
      "postgresql://127.0.0.1:5432/projects/demo?sslmode=disable",
    );
  });
});
