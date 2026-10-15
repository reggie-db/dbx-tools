/**
 * Per-user Unity Catalog namespace derivation and provisioning.
 *
 * @module
 */

import {
  ConfigurationError,
  createWorkspaceClient,
  getExecutionContext,
  type WorkspaceClient,
} from "@databricks/appkit";
import { databricks } from "@dbx-tools/appkit";
import { errorUtils, hash, stringUtils } from "@dbx-tools/shared-core";
import {
  GeneratedSchemaSchema,
  type GeneratedSchema,
  type GeneratorRequest,
} from "@dbx-tools/shared-generator/workflow";

const OWNER_DIGEST_PROPERTY = "dbx_tools.generator.owner_digest";
const REQUEST_DIGEST_PROPERTY = "dbx_tools.generator.request_digest";

/** Inputs needed to provision one deterministic generated schema. */
export interface ProvisionSchemaInput {
  /** Configured parent catalog. */
  catalog: string;
  /** Company and purpose used to derive the schema name. */
  request: Pick<GeneratorRequest, "company" | "purpose">;
}

/** Trusted user identity and clients resolved from the active AppKit request. */
export interface GeneratorIdentity {
  /** OBO workspace client. */
  userClient: WorkspaceClient;
  /** Service-principal workspace client. */
  serviceClient: WorkspaceClient;
  /** Trusted Databricks user name. */
  principal: string;
  /** Trusted stable user id. */
  userId: string;
}

/** Derive a readable, bounded schema name with collision-resistant overflow. */
export function generatorSchemaName(principal: string, company: string, purpose: string): string {
  const base = stringUtils.toIdentifierWithOptions(
    {
      delimiter: "_",
      omitEmailDomain: true,
      maxLength: 96,
      truncateStrategy: "hash",
      truncateHashLength: 8,
    },
    principal,
    company,
    purpose,
  );
  return /^[a-z]/.test(base) ? base : `u_${base}`;
}

/** Resolve the active OBO caller and a separate app service-principal client. */
export async function resolveGeneratorIdentity(): Promise<GeneratorIdentity> {
  const context = getExecutionContext();
  if (!("userId" in context)) {
    throw new ConfigurationError("Generator operations require an on-behalf-of user context");
  }
  const current = await context.client.currentUser.me();
  const principal = stringUtils.trimToNull(current.userName);
  if (!principal) {
    throw new ConfigurationError("The current Databricks user has no userName");
  }
  return {
    userClient: context.client,
    serviceClient: createWorkspaceClient(),
    principal,
    userId: context.userId,
  };
}

/** Return an existing schema, treating only a genuine not-found response as absent. */
async function getSchema(
  client: WorkspaceClient,
  fullName: string,
): Promise<
  | Awaited<ReturnType<ReturnType<WorkspaceClient["toLegacyWorkspaceClient"]>["schemas"]["get"]>>
  | undefined
> {
  try {
    return await client.toLegacyWorkspaceClient().schemas.get({ full_name: fullName });
  } catch (cause) {
    const context = errorUtils.errorContext(cause);
    if (context.hasStatusCode(404) || context.hasMessage("does not exist")) return undefined;
    throw cause;
  }
}

/** Verify that an existing deterministic schema belongs to this user and request. */
function assertSchemaMarkers(
  schema: { properties?: Record<string, string> },
  ownerDigest: string,
  requestDigest: string,
  fullName: string,
): void {
  if (
    schema.properties?.[OWNER_DIGEST_PROPERTY] !== ownerDigest ||
    schema.properties?.[REQUEST_DIGEST_PROPERTY] !== requestDigest
  ) {
    throw new ConfigurationError(
      `Generator schema ${fullName} already exists with different ownership markers`,
    );
  }
}

/**
 * Check-create-recheck one marked schema as the app service principal, then
 * grant the OBO user full schema control while retaining SP ownership.
 */
export async function provisionGeneratorSchema(
  input: ProvisionSchemaInput,
  signal?: AbortSignal,
): Promise<GeneratedSchema> {
  const identity = await resolveGeneratorIdentity();
  return provisionGeneratorSchemaWithIdentity(input, identity, signal);
}

/** Provision with explicit trusted clients, for plugin reuse and isolated tests. */
export async function provisionGeneratorSchemaWithIdentity(
  input: ProvisionSchemaInput,
  identity: GeneratorIdentity,
  signal?: AbortSignal,
): Promise<GeneratedSchema> {
  const catalog = stringUtils.trimToNull(input.catalog);
  if (!catalog) throw new ConfigurationError("GENERATOR_CATALOG is required");

  const schemaName = generatorSchemaName(
    identity.principal,
    input.request.company,
    input.request.purpose,
  );
  const fullName = `${catalog}.${schemaName}`;
  const ownerDigest = hash.fnvHash(identity.userId);
  const requestDigest = hash.fnvHash(identity.userId, input.request.company, input.request.purpose);
  const context = signal ? databricks.toContext(signal) : undefined;

  await identity.userClient.toLegacyWorkspaceClient().catalogs.get({ name: catalog });

  let schema = await getSchema(identity.serviceClient, fullName);
  if (!schema) {
    try {
      await identity.serviceClient.toLegacyWorkspaceClient().schemas.create(
        {
          catalog_name: catalog,
          name: schemaName,
          comment: `Generated demo assets for ${identity.principal}`,
          properties: {
            [OWNER_DIGEST_PROPERTY]: ownerDigest,
            [REQUEST_DIGEST_PROPERTY]: requestDigest,
          },
        },
        context,
      );
    } catch (cause) {
      if (!errorUtils.errorContext(cause).hasMessage("already exists")) throw cause;
    }
    schema = await getSchema(identity.serviceClient, fullName);
  }
  if (!schema) {
    throw ConfigurationError.resourceNotFound("Generator schema", fullName);
  }
  assertSchemaMarkers(schema, ownerDigest, requestDigest, fullName);

  await identity.serviceClient.toLegacyWorkspaceClient().grants.update(
    {
      securable_type: "SCHEMA",
      full_name: fullName,
      changes: [
        {
          principal: identity.principal,
          add: ["ALL_PRIVILEGES", "MANAGE"],
        },
      ],
    },
    context,
  );

  return GeneratedSchemaSchema.parse({
    catalog,
    schema: schemaName,
    fullName,
    principal: identity.principal,
  });
}
