import { describe, expect, test } from "bun:test";
import { AuthKind, TargetKind, type DatabricksAuthOptions } from "@dbx-tools/auth";
import { parseAddress } from "../src/address.ts";
import {
  LakebaseClient,
  type LakebaseApiClient,
  type LakebaseClientDependencies,
} from "../src/client.ts";

describe("Lakebase discovery", () => {
  test("follows pagination and selects usable defaults", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const responses = new Map<string, unknown>([
      [
        "/api/2.0/postgres/projects/project",
        {
          name: "projects/project",
          status: { default_branch: "projects/project/branches/production" },
        },
      ],
      [
        "/api/2.0/postgres/projects/project/branches",
        {
          branches: [
            {
              name: "projects/project/branches/archived",
              status: { current_state: "ARCHIVED", default: true },
            },
          ],
          next_page_token: "next page",
        },
      ],
      [
        "/api/2.0/postgres/projects/project/branches?page_token=next%20page",
        {
          branches: [
            {
              name: "projects/project/branches/production",
              status: { current_state: "READY" },
            },
          ],
        },
      ],
      [
        "/api/2.0/postgres/projects/project/branches/production/endpoints",
        {
          endpoints: [
            {
              name: "projects/project/branches/production/endpoints/disabled",
              status: {
                current_state: "READY",
                disabled: true,
                endpoint_type: "READ_WRITE",
                hosts: { host: "disabled.example" },
              },
            },
            {
              name: "projects/project/branches/production/endpoints/replica",
              status: {
                current_state: "READY",
                endpoint_type: "READ_ONLY",
                hosts: { host: "replica.example" },
              },
            },
            {
              name: "projects/project/branches/production/endpoints/primary",
              status: {
                current_state: "READY",
                endpoint_type: "ENDPOINT_TYPE_READ_WRITE",
                hosts: { host: "primary.example", port: 5433 },
              },
            },
          ],
        },
      ],
      [
        "/api/2.0/postgres/projects/project/branches/production/databases",
        {
          databases: [
            {
              name: "projects/project/branches/production/databases/default",
              status: { postgres_database: "databricks_postgres" },
            },
          ],
        },
      ],
      ["/api/2.0/preview/scim/v2/Me", { userName: "user@example.com" }],
      ["/api/2.0/postgres/credentials", { token: "database-token" }],
    ]);
    const api: LakebaseApiClient = {
      auth: { listProfiles: () => [profile("PROFILE")] },
      async request(path, options) {
        calls.push({ path, body: options?.body });
        if (!responses.has(path)) throw new Error(`Unexpected request ${path}`);
        return responses.get(path);
      },
    };
    const dependencies: LakebaseClientDependencies = {
      createClient: async (_options: DatabricksAuthOptions) => api,
      isDatabricksApp: () => false,
    };
    const client = new LakebaseClient(undefined, dependencies);

    const resolved = await client.resolve(parseAddress("project"), "PROFILE");
    expect(resolved).toEqual({
      project: "project",
      branch: "production",
      endpoint: "projects/project/branches/production/endpoints/primary",
      host: "primary.example",
      port: 5433,
      database: "databricks_postgres",
      user: "user@example.com",
    });
    expect(await client.generateDatabaseCredential(resolved.endpoint, "PROFILE")).toBe(
      "database-token",
    );
    expect(calls.at(-1)).toEqual({
      path: "/api/2.0/postgres/credentials",
      body: { endpoint: resolved.endpoint },
    });
  });
});

function profile(name: string) {
  return {
    name,
    host: "https://workspace.example",
    target: TargetKind.Workspace,
    authKind: AuthKind.PersonalAccessToken,
  };
}
