# `dbx-tools-bus`

Async Postgres topic fan-out for Python services. This package is currently an
unpublished uv-workspace package and is the Python counterpart to
`@dbx-tools/postgres`'s `PostgresTopicBus`.

The public lifecycle and wire shape match Node:

- `PostgresTopicBus(engine, options)`;
- `channelName`;
- `await start()`;
- `await broadcast(topic, TopicPublishInput(...))`;
- `await listen(topic, listener)` returning an async unsubscribe function;
- `await close()`;
- envelope fields `id`, `topic`, `type`, `metadata`, `body`, and `publishedAt`.

Channel derivation ports the Node stable-key and FNV rules, so equivalent channel
parts resolve to the same PostgreSQL identifier in Python and Node.

```python
from dbx_tools.bus import PostgresTopicBus, TopicPublishInput
from dbx_tools.postgres import PostgresEngineConfig, create_async_engine

engine = create_async_engine(workspace_client, PostgresEngineConfig(instance_name="app-db"))
bus = PostgresTopicBus(engine, channel=["billing", "production"])

unsubscribe = await bus.listen("invoice.updated", handle_invoice)
await bus.broadcast(
    "invoice.updated",
    TopicPublishInput(type="invoice.updated", body={"invoice_id": "inv-7"}),
)
```

Delivery is live and unstored, like PostgreSQL `LISTEN`/`NOTIFY` itself. Use a
table or queue when consumers need replay or acknowledgements.
