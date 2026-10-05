# `dbx-tools-models`

Python access to the model discovery, selection, routing, and metadata lifecycle
implemented by `@dbx-tools/model`. The Python distribution is generated from
the Node package and runs its bundled runtime through PythonMonkey. It does not
contain a separate Python model implementation.

## Usage

```python
from dbx_tools.models import create_model_client

models = await create_model_client()

catalogue = await models.list_models()
matches = await models.search_models({"search": "gpt", "limit": 5})
selected = await models.resolve_model({"explicit": "gpt"})
route = await models.route({"explicit": "gpt", "protocol": "responses"})
metadata = await models.metadata(selected["modelId"])
```

`create_model_client()` is the package's only generated function. Its client
owns Databricks authentication, secret-free profile access, endpoint discovery,
principal-isolated in-memory catalogue caching, fuzzy selection, protocol and
URL resolution, request headers, retirement status, capabilities, and published
ITPM, OTPM, and QPH limits.

Pass Node options as a generated dataclass, a dictionary, or keyword fields:

```python
from dbx_tools.models import DatabricksAuthOptions, ModelClientOptions

models = await create_model_client(
    ModelClientOptions(
        auth=DatabricksAuthOptions(profile="DEFAULT"),
        cache_ttl_ms=60_000,
    )
)

keyword_models = await create_model_client(cache_ttl_ms=60_000)
```

Generated function and method names use `snake_case`. Response records retain
their Node contract keys and are exposed as generated `TypedDict` types. The
client itself is a generated `ModelClient` protocol with typed methods and
responses.

## Generation

This package uses the `PythonNodeBundle` generator and PythonMonkey shim set.
The public Node package remains the workspace and watch dependency; the
portable `@dbx-tools/model/python` subpath limits extraction and bundling to the
auth-backed model client without pulling AppKit into Python.

```toml
[tool.dbx_tools.node_bindings]
package = "@dbx-tools/model"
entrypoint = "@dbx-tools/model/python"
layout = "package"
shim_root = "projen/shims/python-node"
```

Regenerate or verify the committed package from the repository root:

```sh
bun run models:python-runtime
bun run models:python-runtime:check
```

`bun run sync --watch` also regenerates the package when its workspace Node
dependency, entrypoint, binding configuration, shim, or function override
changes. All files under `generated-src` are generated and must not be edited by
hand.
