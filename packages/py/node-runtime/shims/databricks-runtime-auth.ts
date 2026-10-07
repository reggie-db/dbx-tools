import { evaluatePython, type PythonFunction, runPythonInThread } from "./host";

import type { DatabricksRuntimeAuthClient } from "@dbx-tools/auth/runtime-auth";
import { isDatabricksAppEnv as isDatabricksAppRuntime } from "@dbx-tools/shared-core/environment-utils";

interface PythonRuntimeMetadata {
  host: string;
  workspaceId: string | null;
  principal: string | null;
}

const createWorkspaceClient = evaluatePython<PythonFunction>(
  "lambda: __import__('databricks.sdk', fromlist=['WorkspaceClient']).WorkspaceClient()",
);
const runtimeMetadata = evaluatePython<PythonFunction>(
  "lambda client: {'host': client.config.host, 'workspaceId': getattr(client.config, 'workspace_id', None), 'principal': getattr(client.config, 'client_id', None) or getattr(client.config, 'username', None) or getattr(client.config, 'auth_type', None)}",
);
const configuredToken = evaluatePython<PythonFunction>("lambda client: client.config.token");
const authenticationHeaders = evaluatePython<PythonFunction>(
  "lambda client: dict(client.config.authenticate())",
);

/** Return SDK-backed auth only inside a Databricks Python runtime. */
export async function databricksRuntimeAuthClient(): Promise<
  DatabricksRuntimeAuthClient | undefined
> {
  if (isDatabricksAppRuntime(process.env) || !process.env.DATABRICKS_RUNTIME_VERSION?.trim()) {
    return undefined;
  }

  const client = await runPythonInThread<unknown>(createWorkspaceClient);
  const metadata = await runPythonInThread<PythonRuntimeMetadata>(runtimeMetadata, client);
  return {
    host: metadata.host,
    ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
    ...(metadata.principal ? { principal: metadata.principal } : {}),
    async token() {
      const token = await runPythonInThread<unknown>(configuredToken, client);
      return typeof token === "string" && token.trim() ? token : undefined;
    },
    async authenticate() {
      const headers = await runPythonInThread<Record<string, unknown>>(
        authenticationHeaders,
        client,
      );
      return Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, String(value)]),
      );
    },
  };
}
