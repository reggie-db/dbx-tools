import {
  ZerobusSdk,
  type RecordType,
  type StreamConfigurationOptions,
  type TableProperties,
  type ZerobusStream,
} from "@databricks/zerobus-ingest-sdk";
import { workspaceClient, cloud } from "@dbx-tools/databricks";

/** Create a Zerobus SDK client for the active Databricks workspace. */
export async function createSdk(): Promise<ZerobusSdk> {
  const workspaceUrl = await workspaceClient.getWorkspaceUrl();
  if (!workspaceUrl) {
    throw new Error("Workspace URL not found");
  }
  const workspaceId = await workspaceClient.getWorkspaceId();
  if (!workspaceId) {
    throw new Error(`Workspace ID not found: workspaceUrl=${workspaceUrl.toString()}`);
  }
  const location = await cloud.resolveCloudLocation(workspaceUrl.toString());
  if (!location) {
    throw new Error(`Workspace location not found: workspaceUrl=${workspaceUrl.toString()}`);
  }
  const domain =
    location.provider === cloud.CloudProvider.Azure
      ? "azuredatabricks.net"
      : "cloud.databricks.com";
  const zerobusEndpoint = `https://${workspaceId}.zerobus.${location.region}.${domain}`;
  return new ZerobusSdk(zerobusEndpoint, workspaceUrl.toString());
}

/** Create an authenticated Zerobus stream for a Unity Catalog table. */
export async function createStream(
  sdk: ZerobusSdk,
  table: TableProperties | string,
  options?: StreamConfigurationOptions,
): Promise<ZerobusStream> {
  function resolveVariable(name: string): string {
    for (const candidate of [`ZEROBUS_${name}`, name]) {
      const value = process.env[candidate];
      if (value) {
        return value;
      }
    }
    throw new Error(`Variable ${name} not found`);
  }
  const streamTableProperties = typeof table === "string" ? { tableName: table } : table;
  const streamClientId = resolveVariable("DATABRICKS_CLIENT_ID");
  const streamClientSecret = resolveVariable("DATABRICKS_CLIENT_SECRET");
  const streamOptions = {
    recovery: true,
    recordType: 0 as RecordType, // RecordType.Json (const enum, can't be referenced under verbatimModuleSyntax)
    ...options,
  };
  return sdk.createStream(streamTableProperties, streamClientId, streamClientSecret, streamOptions);
}
