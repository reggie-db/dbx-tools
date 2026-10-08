# Support service-principal MLflow feedback in Databricks Apps

Date: 2026-10-08

Status: Proposed

## Problem

`@dbx-tools/appkit-mastra` logs MLflow assessments with the active AppKit
execution-context client. In a Databricks App request that client is OBO-scoped.
The MLflow assessments API rejects it:

```text
Provided OAuth token does not have required scopes: mlflow
```

The Apps API in the affected workspace rejects both `mlflow` and `all-apis` in
`user_api_scopes`, so the consumer cannot request a forwarded user token with
the required scope. Traces still export through the Apps telemetry sidecar, but
thumbs and comments return `{ "ok": false }`.

## Expected behavior

- Apps deployments can submit feedback with the app service principal.
- The assessment `source_id` still records the forwarded human email or user id.
- Genie, model, and other tool identity settings do not implicitly change the
  credential used for feedback.
- Non-Apps hosts can retain OBO feedback when their user token includes MLflow.
- The feedback UI appears only when the selected credential path can write an
  assessment.

## Proposed API

Add a feedback credential option to the Mastra plugin:

```ts
mastra({
  feedback: {
    enabled: true,
    credentialMode: "service-principal",
  },
});
```

Supported modes:

- `service-principal`: use the plugin's app-level Workspace client.
- `user`: use the active OBO client and fail clearly when its token lacks
  MLflow scope.
- `auto`: prefer OBO only when the required scope is available, otherwise use
  the service principal.

Keep the forwarded caller identity as `sourceId` regardless of credential mode.
Credential selection authorizes the API request; it does not own the human
assessment.

## Implementation

1. Resolve and retain the app-level Workspace client during plugin setup.
2. Pass the selected feedback client to `mlflow.logFeedback()` instead of
   always using the request execution-context client.
3. Keep experiment lookup, UC trace-prefix resolution, retries, and assessment
   payload construction unchanged.
4. Publish feedback capability in client config only after credential
   validation succeeds.
5. Log the selected credential mode without logging tokens.

## Tests

- Service-principal mode writes an assessment while preserving human
  `source_id`.
- User mode uses the OBO client.
- Auto mode falls back only for a missing MLflow scope, not for permission,
  network, or server errors.
- Experiment manager links continue to use viewer-specific permissions.
- UC-backed trace IDs retain the `trace:/catalog.schema.prefix/tr-*` format.
- Disabled or unusable feedback does not render controls in `ui-mastra`.
