/**
 * Pinned upstream Graphiti package sources.
 *
 * @module
 */

/** Commit shared by the upstream REST and MCP subdirectory packages. */
export const GRAPHITI_UPSTREAM_COMMIT = "2a85bbbf27f3d0d07dd3a8bf6dc8700c5193c066";

/** uv package specs installed beside the published dbx-tools Graphiti wheel. */
export const GRAPHITI_UPSTREAM_PYTHON_DEPENDENCIES = [
  `graph-service @ git+https://github.com/getzep/graphiti.git@${GRAPHITI_UPSTREAM_COMMIT}#subdirectory=server`,
  `mcp-server @ git+https://github.com/getzep/graphiti.git@${GRAPHITI_UPSTREAM_COMMIT}#subdirectory=mcp_server`,
] as const;
