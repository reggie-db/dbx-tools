import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { provisionGeneratorSchemaWithIdentity, type GeneratorIdentity } from "../src/namespace.ts";

describe("generator schema provisioning", () => {
  it("uses SP for schema/grants and OBO only for catalog preflight", async () => {
    const calls: string[] = [];
    let schema:
      | {
          properties?: Record<string, string>;
        }
      | undefined;
    const userClient = {
      toLegacyWorkspaceClient: () => ({
        catalogs: {
          get: async () => {
            calls.push("obo:catalog");
            return { name: "reggie_pierce_aws_catalog" };
          },
        },
      }),
    } as unknown as WorkspaceClient;
    const serviceClient = {
      toLegacyWorkspaceClient: () => ({
        schemas: {
          get: async () => {
            calls.push("sp:schema:get");
            if (!schema) {
              throw Object.assign(new Error("does not exist"), { statusCode: 404 });
            }
            return schema;
          },
          create: async (request: { properties?: Record<string, string> }) => {
            calls.push("sp:schema:create");
            schema = { properties: request.properties };
            return schema;
          },
        },
        grants: {
          update: async (request: { changes?: Array<{ principal?: string; add?: string[] }> }) => {
            calls.push("sp:grants:update");
            assert.deepEqual(request.changes, [
              {
                principal: "reggie@databricks.com",
                add: ["ALL_PRIVILEGES", "MANAGE"],
              },
            ]);
            return {};
          },
        },
      }),
    } as unknown as WorkspaceClient;
    const identity: GeneratorIdentity = {
      userClient,
      serviceClient,
      principal: "reggie@databricks.com",
      userId: "user-1",
    };

    const location = await provisionGeneratorSchemaWithIdentity(
      {
        catalog: "reggie_pierce_aws_catalog",
        request: { company: "Acme", purpose: "Support" },
      },
      identity,
    );

    assert.equal(location.schema, "reggie_acme_support");
    assert.deepEqual(calls, [
      "obo:catalog",
      "sp:schema:get",
      "sp:schema:create",
      "sp:schema:get",
      "sp:grants:update",
    ]);
  });

  it("fails closed when a readable slug belongs to another request", async () => {
    const userClient = {
      toLegacyWorkspaceClient: () => ({
        catalogs: { get: async () => ({ name: "catalog" }) },
      }),
    } as unknown as WorkspaceClient;
    const serviceClient = {
      toLegacyWorkspaceClient: () => ({
        schemas: {
          get: async () => ({
            properties: {
              "dbx_tools.generator.owner_digest": "different",
              "dbx_tools.generator.request_digest": "different",
            },
          }),
        },
        grants: {
          update: async () => {
            throw new Error("grant should not run");
          },
        },
      }),
    } as unknown as WorkspaceClient;

    await assert.rejects(
      provisionGeneratorSchemaWithIdentity(
        {
          catalog: "catalog",
          request: { company: "Acme", purpose: "Support" },
        },
        {
          userClient,
          serviceClient,
          principal: "reggie@databricks.com",
          userId: "user-1",
        },
      ),
      /different ownership markers/,
    );
  });
});
