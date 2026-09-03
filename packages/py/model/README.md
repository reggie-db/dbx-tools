# `dbx-tools-model`

Python contracts and runtime helpers for Databricks Model Serving. This package
mirrors the reusable parts of `@dbx-tools/shared-model` and `@dbx-tools/model`
without AppKit cache or Mastra dependencies.

Install from PyPI:

```bash
pip install dbx-tools-model
```

To install the current `main` branch directly from the repository instead:

```bash
pip install "dbx-tools-model @ git+https://github.com/reggie-db/dbx-tools.git@main#subdirectory=packages/py/model"
```

Key features:

- stable Pydantic endpoint, profile, query, and ranked-result models;
- live endpoint listing through a structural `WorkspaceClient` protocol;
- score-driven model classification with family fallbacks;
- reasoning-effort levels inferred from Databricks served-entity identity, with
  endpoint-family fallback for summaries that omit it;
- flexible family, version, and model parsing shared by classification,
  reasoning, sorting, and downstream integrations;
- exact and fuzzy endpoint resolution with deterministic class ordering;
- Databricks invocation URL and process-serialized per-request authentication
  helpers, so concurrent SDK refreshes converge;
- shared Responses-only endpoint policy, including Codex and GPT 5.4+ while
  excluding GPT-OSS;
- OpenAI chat request sanitization, assistant-prefill repair, and content
  extraction;
- embedding vector extraction with optional dimension validation.

```python
from databricks.sdk import WorkspaceClient
from dbx_tools.model import ModelClass, list_serving_endpoints, resolve_model

endpoints = list_serving_endpoints(WorkspaceClient())
selection = resolve_model(endpoints, model_class=ModelClass.CHAT_BALANCED)
print(selection.model_id)
print(
    next(
        endpoint.reasoning_efforts for endpoint in endpoints if endpoint.name == selection.model_id
    )
)
```

The Python port intentionally omits AppKit `CacheManager` integration,
Mastra-specific adapters, and browser-only schemas. Callers can cache the plain
Pydantic results with their preferred Python cache.

Model-name parsing produces provider-neutral components without maintaining a
second family registry:

```python
from dbx_tools.model.models import parse_model_name

parsed = parse_model_name("databricks-qwen35-122b-a10b")
assert parsed is not None
assert parsed.family == "qwen"
assert parsed.version == (3, 5)
```

## Relationship to the Databricks SDK

Use the native SDK directly when an endpoint name is already known and its typed
query method fits the request. Use this package when endpoint choice, stable
cross-runtime models, OpenAI-shaped HTTP invocation, or provider-neutral chat
and embedding normalization is the repetitive part.

## Module map

- `models` — Pydantic wire contracts plus shared family/version/model parsing;
- `reasoning` — model-family and served-entity reasoning-level inference;
- `classify`, `classes`, `fallback` — model taxonomy and ordering;
- `resolve` — exact/fuzzy ranking and single-model selection;
- `serving` — structural `WorkspaceClient` endpoint listing;
- `invoke` - URLs, Responses-only policy, process-serialized SDK authentication
  headers, and JSON POST helpers;
- `chat`, `embedding` — request repair/sanitization and response extraction.
