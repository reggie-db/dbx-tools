# Model proxy wedges: SpiderMonkey GC storm finalizing PythonMonkey external strings

Status: open (root cause confirmed by live stack sample; no fix landed)
Component: `packages/py/model-proxy`, PythonMonkey (`pythonmonkey` 1.3.2)
First observed: 2026-10-04. Reproduced and sampled live: 2026-10-05.
Severity: high (every model request through the host proxy hangs until manual restart)

## Summary

The per-user model proxy (`dbx_tools.model_proxy`, LiteLLM under Hypercorn,
launchd label `com.dbx-tools.model-proxy`, port 4000) can enter a state where
the process stays alive but stops serving. One CPU core is pinned near 100%
(observed 75 to 79 percent), `/health` and `/v1/models` time out, and every
downstream request hangs. A client such as Codex opens a session and then
receives no tokens, so the symptom at the UI is a "stuck" chat that never
streams.

Root cause, confirmed by a live stack sample of a wedged process: the proxy
thread is pinned inside SpiderMonkey garbage collection, finalizing a large
population of PythonMonkey external strings. The GC runs synchronously on the
single asyncio event-loop thread, so while it churns, the whole server is
unresponsive. The process never exits, so the launchd `KeepAlive` never
respawns it. It stays wedged until something restarts it by hand.

## Impact

- All traffic through the proxy stalls, not just one request. The proxy is
  single-threaded, so once the event-loop thread is in GC, every connection
  (including `/health`) is dead.
- No self-recovery. `KeepAlive` only restarts on process exit, and a GC-bound
  process is alive. It sits wedged until a manual restart.
- Clients that interrupt and resend (Codex's interrupt then re-init then steer
  sequence) can orphan a queued message, surfacing a secondary "queued message
  not found" error that hides the real cause.

## How to confirm it live (do this before restarting)

A wedged process is the evidence. Capture a stack before killing it:

```sh
PID=$(lsof -nP -iTCP:4000 -sTCP:LISTEN -t | head -1)
ps -o pid,etime,%cpu,stat -p "$PID"      # expect high %CPU, state R
sample "$PID" 3 -mayDie                   # macOS built-in; writes a stack sample
```

If the sample's main thread call graph ends in
`js::gc::GCRuntime::...performSweepActions -> FinalizeArenas ->
Arena::finalize<JSExternalString> -> PythonExternalString::finalize` with the
hot leaves in `std::__hash_*` and `PyUnicode_*`, this is the bug.

## Observed stack (2026-10-05, pid 97574, 9h18m uptime, 75% CPU)

All 2075 of 2075 main-thread samples were in GC string finalization:

```
DispatchQueue_1: com.apple.main-thread
  eventLoopJobWrapper (pythonmonkey.so)
   JSFunctionProxy_call -> JS_CallFunctionValue -> js::Call -> InternalCallOrConstruct
    PromiseReactionJob -> AsyncFunctionResume -> CallSelfHostedFunction -> RunScript
     js::jit::MaybeEnterJit -> [jitcode] -> js::jit::CheckOverRecursed
      JSContext::handleInterrupt
       js::gc::GCRuntime::gcIfRequestedImpl -> collect -> gcCycle -> incrementalSlice
        performSweepActions -> SweepActionForEach -> endSweepingSweepGroup
         queueZonesAndStartBackgroundSweep -> GCParallelTask::runFromMainThread
          sweepFromBackgroundThread -> sweepBackgroundThings
           FinalizeArenas -> Arena::finalize<JSExternalString>
            PythonExternalString::finalize(char16_t*)
             PyUnicode_DATA / _PyUnicode_COMPACT_DATA / PyUnicode_IS_ASCII ...
             std::unordered_map<_object*, unsigned long>::cend / end / iterate
```

Hot leaves by sample count: `std::__hash_value_type` (63), `std::__hash_node`
(53), `std::__hash_const_iterator` (42), `std::__hash_map_const_iterator` (22),
`PythonExternalString::finalize` (9), `PyUnicode_*` (several). The 8 "JS Helper"
threads were idle; Python threads were parked in `PyThread_acquire_lock_timed`
(the asyncio loop waiting). The sample is saved at
`/tmp/proxy-wedge-97574.sample.txt` for reference.

## Root cause

PythonMonkey marshals Python `str` objects into JavaScript as **external
strings**: the JS string points at the Python buffer instead of copying, and
PythonMonkey keeps per-object bookkeeping in a `std::unordered_map<PyObject*,
...>`. When SpiderMonkey's GC sweeps these, each `JSExternalString` finalize
calls back into CPython (`PyUnicode_*`) and does a hash-map operation.

The cost of a GC sweep therefore scales with the number of live external
strings. The proxy is a long-running process that crosses the Python/JS bridge
on every request (per-call token resolution in `routing.py`, plus model-catalog
and streaming traffic), so external strings accumulate. Eventually a GC cycle
has so much to finalize that a single sweep runs for seconds or longer. Because
GC is triggered synchronously during JS execution (`handleInterrupt ->
gcIfRequested`), that sweep happens on the event-loop thread and blocks the
entire server. One core pins at ~100% doing `std::__hash_*` lookups per string;
`/health` and every request freeze; nothing recovers because the process never
exits.

The JS runtime (`_runtime.js`) also uses `FinalizationRegistry` (3 occurrences),
whose callbacks run during GC and add to the finalize workload. This is a
secondary contributor worth examining.

### Ruled out: the file-lock shim

An earlier draft of this RCA blamed the credential file-lock shim
(`projen/shims/python-node/file-lock.ts`), which replaces the production
`proper-lockfile` (with stale recovery) with a bare `filelock`/flock that has no
stale reclaim, combined with an unbounded hold in `withLock`
(`packages/js/node/auth/src/lifecycle.ts`). The live sample disproves that as
the cause of the spin: zero samples are in flock, filelock, or the lock poll
loop. The entire thread is in GC string finalization.

The file-lock shim remains a real latent robustness gap (a genuinely hung holder
would not self-heal), but it is not what wedged the proxy here. Track it
separately rather than as this bug's root cause.

## The defect, confirmed in PythonMonkey source

The GC storm is a quadratic algorithm in PythonMonkey itself
(`Distributive-Network/PythonMonkey`, `src/jsTypeFactory.cc`, present on `main`
as of 2026-10-05, matching the vendored 1.3.2). PythonMonkey tracks every
Python string it lends to JavaScript as an external string in:

```cpp
std::unordered_map<PyObject *, size_t> externalStringObjToRefCountMap;
```

The map is keyed by `PyObject *`, but the three hot methods are handed only the
raw character buffer (`chars`), so each one linearly scans the entire map to
find the matching entry:

```cpp
void PythonExternalString::finalize(char16_t *chars) const {
  if (Py_IsFinalizing()) { return; }
  for (auto it = ...cbegin(), next_it = it; it != ...cend(); it = next_it) {
    next_it++;
    if (PyUnicode_DATA(it->first) == (void *)chars) { Py_DECREF(...); /* dec/erase */ }
  }   // no break: always a full O(N) scan
}
```

`getPyString` and `sizeOfBuffer` scan the same way. During one GC sweep that
finalizes M external strings while N are live, this is O(N*M), effectively
O(N^2). As the live external-string population grows over hours of per-request
bridge traffic, a single sweep crosses from microseconds into seconds, runs
synchronously on the event-loop thread, and wedges the proxy. The live sample
is entirely in this scan (`std::__hash_*` under `PythonExternalString::finalize`).

Upstream status: no issue or PR addresses this performance bug. The only related
change is a 2024 refcount correctness fix (`4e0704363`). The scan is unfixed on
`main`.

## Validation metrics (observability only, never a restart)

To confirm the fix holds and to catch regressions, add plain log points. These
are measurement, not a watchdog: nothing here restarts or kills the process.

- Every 60s log: process RSS, event-loop lag (schedule `call_later(0)`, record
  overshoot), and the live external-string count (see below). A flat
  external-string count and flat loop lag over a multi-hour soak is the pass
  signal; a climbing count is the regression signal.
- Per-call `route()` duration in `routing.py`, logged as a warning past a
  threshold. Rising bridge latency is the leading indicator of GC pressure.
- Live external-string count: expose the size of `externalStringObjToRefCountMap`
  (a one-line accessor added in the same PythonMonkey patch below), or, until
  that lands, time a forced `pythonmonkey.collect()` as a proxy metric.

## Fix plan (implementation)

The fix is to eliminate the quadratic, not to detect it and restart. There is
deliberately no watchdog, no stall-timer, and no self-exit in this plan: a
process that kills and respawns itself is a crutch that hides the bug and still
drops in-flight requests. Phase 1 removes the O(N^2); Phase 2 bounds N as a
belt-and-suspenders that ships independently; Phase 0 is hygiene; Phase 3 is a
structural fallback only if the real fix cannot be carried.

### Phase 0 — atomic singleton runtimes (hygiene, do first)

Audit (2026-10-05) found both Python-side runtimes are already singletons, so
multiple JS engines are not the GC cause. But the creation paths should be made
provably atomic and expressed as cache annotations so a second instance can
never be constructed under concurrency:

- `_generated/node_bindings.py` `_runtime()` holds the one `pm.require(...)` in a
  module global `_RUNTIME`. It is synchronous and unlocked, so two threads could
  both enter and call `pm.require`. PythonMonkey keeps a single SpiderMonkey
  runtime per process regardless, but the Python wrapper should still be atomic.
- `runtime.py` `get_runtime()` holds the one `ModelProxyRuntime` in `_runtime`
  behind a double-checked `_runtime_lock`. All callers (`routing.py`,
  `models_api.py`) go through it.

Changes:

1. Annotate the sync engine factory with `functools.cache`, which is atomic and
   idempotent by construction (CPython computes the cached value under a lock and
   never re-runs the body):

   ```python
   from functools import cache

   @cache
   def _runtime() -> Any:
       return pm.require(str(Path(__file__).with_name("_runtime.js")))
   ```

   `node_bindings.py` is generated ("GENERATED ... DO NOT EDIT"), so this change
   belongs in the bindings generator template (the projen task that emits
   `_runtime()`), not a hand edit, or it will be overwritten on regenerate.

2. For the async `get_runtime()`, do NOT use `functools.cache`: it would cache
   the coroutine object, which is awaitable exactly once and raises on reuse.
   Use an atomic cached-future instead, so concurrent first-touch callers await
   one shared creation and the resolved value is cached:

   ```python
   _runtime_future: asyncio.Future[ModelProxyRuntime] | None = None
   _runtime_lock: asyncio.Lock | None = None   # built lazily, bound to the live loop

   async def get_runtime() -> ModelProxyRuntime:
       global _runtime_future, _runtime_lock
       if _runtime_future is not None:
           return await _runtime_future            # fast path, already resolved
       if _runtime_lock is None:
           _runtime_lock = asyncio.Lock()
       async with _runtime_lock:
           if _runtime_future is None:
               _runtime_future = asyncio.ensure_future(ModelProxyRuntime.create())
       return await _runtime_future
   ```

   This is the atomic equivalent of a cached singleton for async factories: one
   creation, deduped in-flight, cached result. Build `_runtime_lock` lazily
   rather than at import so it binds to the running loop PythonMonkey uses, not
   whatever loop happened to exist at import time.

3. `switch_profile()` reassigns `self.client` to a new `create_model_client`
   result. Explicitly dispose the previous client (if the JS `ModelClient`
   exposes a close/dispose) so its external strings and handles are freed
   deterministically instead of waiting for GC; if there is no dispose, call
   `pythonmonkey.collect()` once after the swap. Keep `switch_profile` serialized
   under the existing `self._client_lock`.

4. Add a one-time guard: if a second engine or runtime construction is ever
   attempted, log a warning with a stack, so accidental non-singleton use is
   caught in tests and logs.

Acceptance: a stress test issuing many concurrent first-touch requests
constructs exactly one `ModelProxyRuntime` and one `pm.require`; repeated
`switch_profile` calls do not step RSS upward (old clients are freed).

### Phase 1 — eliminate the O(N^2) in PythonMonkey (the actual fix)

Make the three external-string lookups O(1) instead of full-map scans. The
reason they scan is that `finalize`/`getPyString`/`sizeOfBuffer` receive only
the `chars` buffer pointer while the map is keyed by `PyObject *`. Add a second
index keyed by the buffer pointer, which is stable for a `PyUnicode` object's
lifetime (`PyUnicode_DATA(obj)`):

```cpp
// jsTypeFactory.cc
std::unordered_map<PyObject *, size_t> externalStringObjToRefCountMap;
std::unordered_map<const void *, PyObject *> externalStringBufToObjMap; // chars -> owner

// on create (where the map is incremented today):
externalStringBufToObjMap[PyUnicode_DATA(object)] = object;

// finalize becomes O(1):
void PythonExternalString::finalize(char16_t *chars) const {
  if (Py_IsFinalizing()) { return; }
  auto found = externalStringBufToObjMap.find((const void *)chars);
  if (found == externalStringBufToObjMap.end()) { return; }
  PyObject *obj = found->second;
  Py_DECREF(obj);
  if (--externalStringObjToRefCountMap[obj] == 0) {
    externalStringObjToRefCountMap.erase(obj);
    externalStringBufToObjMap.erase(found);
  }
}
```

`getPyString` and `sizeOfBuffer` use the same `find`. Also expose a tiny
`externalStringObjToRefCountMap.size()` accessor for the validation metric.

Delivery, in order of preference:

1. Contribute the patch upstream to `Distributive-Network/PythonMonkey` and pin
   to the released version once merged. This is the clean, permanent fix.
2. Until a release lands, carry a patched PythonMonkey build in the corporate
   package registry and pin `model-proxy`'s dependency to it. PythonMonkey ships
   a compiled wheel bundling SpiderMonkey, so this means a source build in CI;
   scope that spike before committing to it.

Acceptance: a soak test that marshals a large, growing set of distinct Python
strings across the bridge shows flat GC sweep time and flat `route()` latency as
the external-string count climbs (quadratic gone). The reproduction is a loop of
model-proxy requests over several hours with the Phase 2 metric logging.

### Phase 2 — bound the live external-string count (ships now, independent)

This holds the proxy stable immediately and keeps N small enough that even the
unpatched quadratic cannot wedge it, so it is worth landing before the upstream
patch is released:

1. Reduce what we retain as external strings. Audit `_runtime.js` for caches
   that hold Python-backed strings alive (model catalog, auth/token payloads,
   anything cached by `cacheTtlMs`). Store JS-owned copies (for example
   `String(value)` / structuredClone of the parsed object) so no long-lived
   `externalStringObjToRefCountMap` entry persists. Short-lived per-call strings
   are fine; retained ones are what grow N.
2. Reduce churn across the bridge. `routing.py` already passes only small args
   (model name, protocol, a bool); focus on `models()`/`metadata()` catalog
   traffic and any streamed content that crosses as Python strings.
3. Review the `_runtime.js` `FinalizationRegistry` usages (3); their callbacks
   run during GC and add finalize load. Confirm each is necessary.

### Phase 3 — out-of-process isolation (structural fallback only)

Only if the Phase 1 patch cannot be carried: run PythonMonkey in a child Python
process (same venv and wheel, so no new Node dependency) over a unix-socket
JSON-RPC. A GC storm then pins the child, not Hypercorn's loop, and the parent
can time out and replace the child. This is a bindings-generator-level transport
change; prefer fixing the algorithm (Phase 1) over isolating it.

### Rejected

- Switching ASGI server (uvicorn, granian): all run one asyncio thread per
  worker; the same GC sweep wedges them.
- Multiple workers (`--num_workers`): mask but do not fix, and multiply the
  PythonMonkey engine and its GC load; a sick worker still pins a core.
- True Node sidecar: reintroduces the Node runtime dependency PythonMonkey
  exists to avoid. Phase 3's Python-child transport gets isolation without it.

## Immediate mitigation

```sh
launchctl kickstart -k "gui/$(id -u)/com.dbx-tools.model-proxy"
# then poll until 200 (about 18 to 40 seconds)
curl -s -m 4 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4000/health
```

The tray sibling is `com.dbx-tools.model-proxy.tray`.

## References

- Live stack sample: `/tmp/proxy-wedge-97574.sample.txt`
- `src/dbx_tools/model_proxy/_generated/node_bindings.py` (PythonMonkey bridge)
- `src/dbx_tools/model_proxy/routing.py` (per-call token resolution hook)
- `src/dbx_tools/model_proxy/cli.py` (LiteLLM `run_server` entry; metrics install point)
- Upstream defect: `Distributive-Network/PythonMonkey` `src/jsTypeFactory.cc`
  (`externalStringObjToRefCountMap`, `PythonExternalString::finalize/getPyString/sizeOfBuffer`)
- `src/dbx_tools/model_proxy/service.py` (launchd plist, `KeepAlive: true`)
- Latent, not this bug: `projen/shims/python-node/file-lock.ts`,
  `packages/js/node/core/src/file-lock.ts`, `packages/js/node/auth/src/lifecycle.ts`
- Logs: `~/.dbx-tools/model-proxy/service.log`, `~/.dbx-tools/model-proxy/tray.log`
