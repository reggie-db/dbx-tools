import { Config, type CredentialProvider, WorkspaceClient } from "@databricks/sdk-experimental";

import {
  createPersistentAuth,
  type DatabricksAuthDependencies,
  PersistentAuth,
} from "./databricks.ts";
import type { DatabricksAuthOptions } from "./types.ts";

/** Create the Databricks SDK client while retaining dbx-tools token lifecycle policy. */
export async function createWorkspaceClient(
  optionsOrAuth: DatabricksAuthOptions | PersistentAuth = { preferUserToMachine: true },
  dependencies: DatabricksAuthDependencies = {},
): Promise<WorkspaceClient> {
  const auth =
    optionsOrAuth instanceof PersistentAuth
      ? optionsOrAuth
      : await createPersistentAuth(optionsOrAuth, undefined, dependencies);
  const status = auth.status();
  const credentials: CredentialProvider = {
    name: "default",
    async configure() {
      return async (headers) => {
        const token = await auth.token();
        headers.set("authorization", `${token.tokenType} ${token.accessToken}`);
        if (auth.workspaceId()) headers.set("x-databricks-workspace-id", auth.workspaceId()!);
      };
    },
  };
  return new WorkspaceClient(
    new Config({
      host: status.host,
      ...(auth.workspaceId() ? { workspaceId: auth.workspaceId() } : {}),
      credentials,
    }),
  );
}

export { WorkspaceClient };
