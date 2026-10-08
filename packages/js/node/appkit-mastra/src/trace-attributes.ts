/** Prefix Databricks/MLflow copies onto the unified-view trace tags map. */
export const MLFLOW_TRACE_TAG_PREFIX = "mlflow.traceTag.";

/** Experiment-UI tag marking every Mastra chat turn as an agent trace. */
export const MLFLOW_AGENT_TAG = "agent";

/** Experiment-UI tag marking a turn that called Genie. */
export const MLFLOW_GENIE_TAG = "genie";

/** Experiment-UI tag recording the model or ordered models used by a turn. */
export const MLFLOW_MODEL_TAG = "model";

/** Experiment-UI tag marking a turn that invoked OBO authentication. */
export const MLFLOW_OBO_AUTH_TAG = "obo_auth";

/** Experiment-UI tag marking a turn that invoked service-principal authentication. */
export const MLFLOW_SP_AUTH_TAG = "sp_auth";

/** Experiment-UI tag marking a turn emitted outside Databricks Apps. */
export const MLFLOW_LOCAL_TAG = "local";

/** Attribute key for the `agent` trace tag. */
export const MLFLOW_AGENT_TAG_ATTR = `${MLFLOW_TRACE_TAG_PREFIX}${MLFLOW_AGENT_TAG}`;

/** Attribute key for the `genie` trace tag. */
export const MLFLOW_GENIE_TAG_ATTR = `${MLFLOW_TRACE_TAG_PREFIX}${MLFLOW_GENIE_TAG}`;

/** Attribute key for the `model` trace tag. */
export const MLFLOW_MODEL_TAG_ATTR = `${MLFLOW_TRACE_TAG_PREFIX}${MLFLOW_MODEL_TAG}`;

/** Attribute key for the `obo_auth` trace tag. */
export const MLFLOW_OBO_AUTH_TAG_ATTR = `${MLFLOW_TRACE_TAG_PREFIX}${MLFLOW_OBO_AUTH_TAG}`;

/** Attribute key for the `sp_auth` trace tag. */
export const MLFLOW_SP_AUTH_TAG_ATTR = `${MLFLOW_TRACE_TAG_PREFIX}${MLFLOW_SP_AUTH_TAG}`;

/** Attribute key for the `local` trace tag. */
export const MLFLOW_LOCAL_TAG_ATTR = `${MLFLOW_TRACE_TAG_PREFIX}${MLFLOW_LOCAL_TAG}`;
