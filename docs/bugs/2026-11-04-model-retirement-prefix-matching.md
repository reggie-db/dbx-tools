# Retired model prefix matching excludes active later versions

Status: Open

## Summary

`@dbx-tools/model` can mark an active point release as deprecated when a
retired model name is a token prefix of the active model. The ranker then
removes the active endpoint before fuzzy matching. A loose model request is
returned unchanged and Databricks Model Serving rejects it with
`ENDPOINT_NOT_FOUND`.

The observed case is Claude Sonnet 4.5. The committed retirement snapshot
contains `Anthropic Claude Sonnet 4`, while the workspace contains the active,
ready endpoint `databricks-claude-sonnet-4-5`.

## Observed deployment

- Application: `lakespan`
- `@dbx-tools/model`: `0.9.198`
- `@dbx-tools/appkit-mastra`: `0.9.198`
- Workspace model request: `claude sonnet 4 5`
- Available endpoint: `databricks-claude-sonnet-4-5`
- Endpoint state: `READY`

The resolver produced:

```json
{
  "modelId": "claude sonnet 4 5",
  "source": "fuzzy-match"
}
```

The provider then called Databricks Model Serving with the unresolved model
name. Databricks returned:

```json
{
  "error_code": "ENDPOINT_NOT_FOUND",
  "message": "The given endpoint does not exist, please retry after checking the specified model and version deployment exists."
}
```

## Root cause

`packages/js/node/model/src/retirement.ts` normalizes the retired model name to
`claude-sonnet-4` and the active endpoint to `claude-sonnet-4-5`. It marks a
model deprecated when either the keys are equal or the candidate starts with
the retired key plus a hyphen:

```ts
if (candidate === key || candidate.startsWith(`${key}-`)) return true;
```

This makes `claude-sonnet-4-5` a deprecated descendant of
`claude-sonnet-4`, even though `4.5` is a separate model version.

`packages/js/node/model/src/_ranking.ts` excludes deprecated endpoints before
token and Fuse matching. Once Sonnet 4.5 is removed, the nearest remaining
matches score approximately `0.427`, above the default `0.4` threshold. The
resolver therefore returns the original loose string. The result still reports
`source: "fuzzy-match"`, although no endpoint matched.

## Expected behavior

- Retiring Claude Sonnet 4 does not deprecate Claude Sonnet 4.5 or later
  versions.
- `claude sonnet 4 5` resolves to `databricks-claude-sonnet-4-5` when that
  endpoint is available and ready.
- A failed fuzzy lookup reports that no match occurred instead of labeling the
  unresolved input as a fuzzy match.
- Retired dated or provider-specific variants continue to inherit retirement
  status when they represent the same model release.

## Workaround

Use the exact endpoint ID:

```ts
defaultModel: "databricks-claude-sonnet-4-5"
```

When fuzzy selection returns this value unchanged, it remains a valid Model
Serving endpoint ID.

## Required remediation

1. Replace general string-prefix retirement matching with identity-aware
   matching that distinguishes version components from release suffixes.
2. Add retirement regression fixtures covering a retired major version and an
   active later point release, including Sonnet 4 and Sonnet 4.5.
3. Preserve matching for aliases and dated variants of the same retired model
   without treating later semantic model versions as descendants.
4. Return explicit no-match metadata when fuzzy selection leaves an input
   unchanged.

## Acceptance tests

- `modelStatusFor("databricks-claude-sonnet-4")` reports deprecated.
- `modelStatusFor("databricks-claude-sonnet-4-5")` does not report deprecated
  solely because Sonnet 4 is retired.
- A loose `claude sonnet 4 5` request resolves to the ready Sonnet 4.5 endpoint.
- A dated alias of an actually retired model remains deprecated.
- An unmatched loose request does not report `source: "fuzzy-match"`.
