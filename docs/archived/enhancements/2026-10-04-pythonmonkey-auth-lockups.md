# PythonMonkey auth/model lockups — remediation plan

Status: proposed (no code written yet)
Date: 2026-10-04
Owners: auth (`packages/js/node/auth`), model (`packages/js/node/model`), shims (`projen/shims/python-node`)

This plan addresses recurring "PythonMonkey lockups" seen in the model-proxy auth path.
It consolidates a prior investigation (reproduced below, unedited for the next agent's
context) with first-hand verification against the current tree, then lays out an ordered
fix with the design decisions already made.

---

## 1. Prior agent findings (verbatim, for context)

> I found a real locking defect on current `main` / v0.9.28. The check-lock-check logic
> exists, but the in-memory lock's timeout cleanup breaks mutual exclusion.
>
> ### Primary failure
>
> `MemoryLockAdapter.acquire()` (`packages/js/node/auth/src/storage.ts:12-37`) deletes the
> key's tail when the latest waiter times out:
>
> ```ts
> release();
> if (this.#tails.get(key) === tail) this.#tails.delete(key);
> ```
>
> That tail still represents an earlier active holder. Deleting it allows the next caller to
> acquire immediately while the original holder remains inside the critical section.
>
> I reproduced this exact sequence:
>
> 1. A acquires `k`.
> 2. B waits for `k` and times out.
> 3. A is still holding `k`.
> 4. C requests `k` and acquires in 1 ms.
>
> So after one timeout, check-lock-check operations can run concurrently. The existing timeout
> regression test (`packages/js/node/auth/test/lifecycle.test.ts:97-104`) misses this because
> it releases A before trying C.
>
> ### Why that becomes a proxy "lockup"
>
> The normal token path does correctly check, lock, then recheck in `TokenLifecycle.loadToken()`
> (`lifecycle.ts:77-98`). The default model-proxy auth backend is the broken in-memory store
> (`createPersistentAuth()`, `databricks-auth.ts:196-220`). The lock is held across the complete
> token acquisition operation in `withLock()` (`lifecycle.ts:187-209`). For U2M auth,
> `databricks auth token` is launched without any timeout in `databricksCliToken()`
> (`databricks-cli.ts:172-183`).
>
> The resulting failure sequence is:
>
> ```text
> request A
>   acquires credential lock
>   starts unbounded `databricks auth token`
>   CLI hangs
> request B
>   waits 30 seconds
>   times out
>   incorrectly removes the active queue tail
> request C
>   bypasses A's lock
>   starts another token command
> subsequent requests
>   repeat, overlap authentication, or wait behind hung operations
> ```
>
> The configured 30-second `lockTimeoutSeconds` only limits waiting for the lock. It does not
> limit how long the holder's refresh/authentication action may run.
>
> ### Python bridge makes timeout handling weaker
>
> The Python child-process shim handles abort by emitting an error, but it does not terminate
> the underlying Python subprocess; `kill()` is also a no-op. See `child-process.ts:18-53`. It
> also calls `pythonHost().process.run(..., undefined)` with no subprocess timeout. Therefore
> even code paths with an `AbortController` can leave a background `subprocess.run()` alive. The
> token command has neither an abort timer nor a host timeout.
>
> ### Secondary issues
>
> - The Python file-lock replacement uses a different `.flock`/`filelock` protocol from the Node
>   `proper-lockfile` implementation. Python and Node processes therefore do not actually
>   coordinate if file storage is enabled. Not the default model-proxy path, but another lock
>   correctness problem.
> - Model-catalogue requests share one in-flight promise whose expiration is initially
>   `Infinity`. That is intentional coalescing, but a promise that never settles makes every
>   catalogue caller appear locked. See `model-client.ts:199-215`.
> - The Python `_runtime_lock` and `_client_lock` are not the primary problem. Both use
>   `async with`; their release behavior is sound. Profile switching has a reader/writer race,
>   but it does not explain a permanent stall.
>
> ### Recommended fix order
>
> 1. Fix `MemoryLockAdapter` so a timed-out waiter removes only itself and never erases an
>    earlier active holder. A per-key `{ locked, queue }` mutex state machine would be clearer
>    than chained tail promises.
> 2. Add the missing regression: after B times out, C must still time out while A remains held.
> 3. Bound the entire provider acquisition/refresh operation, including `databricks auth token`.
> 4. Make the Python subprocess shim propagate the timeout to Python and actually terminate
>    timed-out child processes.
> 5. Add a model-proxy concurrency test through the generated PythonMonkey binding, not only the
>    pure TypeScript lifecycle tests.

---

## 2. Verification against the current tree

Each finding was checked against the files as they stand today.

- **CONFIRMED — `MemoryLockAdapter` tail deletion defect.** `storage.ts:24-28`. On timeout the
  waiter calls `release()` (resolving its own `current`) and then deletes
  `this.#tails.get(key)` when it still equals its own `tail`. Because `tail = previous.then(() =>
  current)`, the timed-out waiter's `tail` is the *latest* link in the chain while an earlier
  holder is still active. Deleting it resets the chain to `Promise.resolve()`, so the next
  `acquire` sees no predecessor and proceeds immediately — concurrent entry into the critical
  section. The chained-tail design cannot distinguish "I am the active holder" from "I am the
  newest waiter," which is the root cause.

- **CONFIRMED (but by design, per §3) — lock held across unbounded CLI token acquisition.**
  `lifecycle.ts:187-209` (`withLock`) wraps `renew()` which awaits
  `provider.refresh/authenticate/login`. For U2M that is `databricksCliToken()`
  (`databricks-cli.ts:173-212`) whose `runProcess` call passes no `timeoutMs`
  (`databricks-cli.ts:182`). The prior agent flagged this as a bug to bound; the owner has
  decided the holder is ALLOWED to run indefinitely (browser login ~15 min). So this is intended
  behavior, NOT something to cap with a timeout. The real defects are (a) the queue corruption
  that let a waiter bypass the holder, and (b) a cancelled request leaking a live child — both
  addressed without any time limit. `lockTimeoutSeconds` only ever bounded *waiting*
  (`storage.ts:23`) and is being made opt-in.

- **CONFIRMED — child-process shim cannot cancel Python work.** `child-process.ts:28-29` calls
  `pythonHost().process.run(command, args, env, undefined, undefined)` — `input=undefined`,
  `timeoutMs=undefined`. On abort (`child-process.ts:20-27`) it only emits a JS `error` and sets
  `active=false`; the Python `subprocess.run` keeps running on its `asyncio.to_thread` worker
  (`host.ts:243-257`, `runProcess` lambda `host.ts:123-125`). `kill()` returns `false`
  (`child-process.ts:51-53`) — a true no-op. So even an abort-aware caller leaks a live child.

- **CONFIRMED — sync file access inside async shim paths.** The host exposes `exists` as a
  synchronous Python eval (`host.ts:153`, backing `fs.existsSync` at `fs.ts:15-17` and
  `readTextSync` at `host.ts:172` backing `fs.readFileSync` at `fs.ts:19-21`). Those blocking
  Python calls run on the JS thread. Beyond the inherently-sync Node APIs, async code paths also
  make synchronous host calls: `fs-promises.unlink` calls `pythonHost().file.exists(...)`
  synchronously (`fs-promises.ts:92`), and inside `host.ts` the async `mkdir`/`remove` methods
  call `osPath.exists(path)` synchronously (`host.ts:155`, `host.ts:177`) and `remove` makes
  several synchronous `evaluate(...)` calls for `isdir`/`rmtree`/`unlink` (`host.ts:181-187`).
  These block PythonMonkey's single thread while file I/O runs.

- **CONFIRMED — model catalogue in-flight promise expiry is `Infinity`.** `model-client.ts:205`.
  This is intentional request coalescing and is self-healing on rejection (`model-client.ts:211-213`
  deletes the entry). It only "locks" when the underlying `fetchCatalogue` → `client.request` →
  auth hangs forever with no caller cancellation. Per §3 (owner direction) that is accepted — the
  caller owns the request budget — so no cache redesign is required. Noted here so the next agent
  does not "fix" the coalescing with a timer.

- **CONFIRMED — Python file-lock vs Node protocol mismatch.** `file-lock.ts:40-61` uses the
  Python `filelock` package against a `<id>.flock` path, while Node core uses `proper-lockfile`
  (see `packages/js/node/core/src/file-lock.ts`). They do not interoperate. Not the default
  model-proxy path (default storage is Memory, `databricks-auth.ts:207`), so this is secondary.

- **NOTED — `process-lock.ts` is the reference design.** `packages/js/node/core/src/process-lock.ts:88-182`
  already implements the exact `{ owner, queue }` per-key state machine the prior agent
  recommends, including correct FIFO promotion and "ignore a release from a non-owner"
  semantics (`release()` at `:147-151`). The `MemoryLockAdapter` rewrite should mirror this
  proven shape rather than invent a new one.

---

## 3. Design principles and decisions

### Principles (owner-directed)

These supersede the prior investigation's "bound the holder" recommendation (item 3):

1. **No token/holder timeout.** Provider token acquisition (`databricksCliToken`,
   `databricksCliLogin`, `authenticate`, `refresh`) is NOT wrapped in a timeout. A U2M login
   launches a browser and can legitimately take ~15 minutes; the Databricks CLI already owns
   that budget via its own `--timeout`. Imposing a second timeout would abort valid logins.
2. **The caller owns request timeouts.** LiteLLM / the model-proxy caller is responsible for
   bounding a request. When it gives up (or the CLI exits non-zero), the provider action
   rejects, `withLock`'s `finally` (`lifecycle.ts:197-208`) releases the lock automatically, and
   the caller surfaces an error (e.g. 401). Locks are released by the error path, not by a timer.
3. **Locks hold indefinitely and never block a thread.** `acquireLock` waits forever by default
   (owner decision: "wait indefinitely"); a waiter blocks only in the async sense (awaiting a
   promise) and must never spin, busy-poll, or run synchronous blocking I/O on the Node event
   loop or on a Python thread. `lockTimeoutSeconds` becomes opt-in; the default is no wait
   timeout.
4. **Cancellation must actually tear down work.** When a request is cancelled, the underlying
   Python subprocess must be killed (not leaked) so nothing keeps running after the lock is
   released. This is the one place abort propagation matters — not for imposing timeouts, but so
   a cancelled/abandoned request does not leave a live `databricks` process behind.

### 3.1 Lock: custom state machine, not a library

The user asked to prefer a library "if a memory cache library makes more sense than something
custom." Assessment: this component is a **keyed mutex with indefinite async waiting +
lease-handle release**, not a cache. Candidate libraries (`async-mutex`) provide an unkeyed
`Mutex`/`Semaphore` and would still need a per-key `Map` wrapper and lease-id bookkeeping to
satisfy the `LockAdapter` contract (`types.ts:132-136`). That wrapper is where the current bug
lives, so a dependency removes none of the risk. The repo also favors small dependency-free
primitives (AGENTS.md "reuse first"; `shared-core` is deliberately dependency-free) and already
owns a correct reference implementation in `process-lock.ts`. **Decision: rewrite
`MemoryLockAdapter` as a per-key `{ locked, queue }` state machine modeled on `process-lock.ts`;
add no dependency.** Waiting is purely promise-based (await a queued resolver) so it never blocks
the event loop; by default there is no wait timeout (holds indefinitely).

### 3.2 Cache: leave model catalogue coalescing as-is

The catalogue "cache" is correct once the lock is correct. No library swap. **Decision: no change
to `model-client.ts` caching.** (A library like `lru-cache` would add eviction we do not need and
would not address the hang.) It coalesces in-flight callers and self-heals on rejection; when a
caller cancels/errors the shared promise rejects and the entry is dropped. A hung-forever
catalogue only happens if the CLI hangs with no caller cancel — which per §3 principle 1 is
accepted behavior, not a defect to "fix" with a timer.

### 3.3 Timeouts: none on the holder; caller owns the budget

**Decision: do NOT add any provider/token timeout.** This reverses the prior investigation's
item 3. Rationale in §3 principles 1-2. Concretely:

- `databricksCliToken`, `databricksCliLogin`, `authenticate`, and `refresh` keep running with no
  imposed process timeout. The CLI's own `--timeout` (login) remains the only budget.
- The lock is released automatically when the provider action settles (success OR error) via
  `withLock`'s `finally`. A caller that abandons a request (LiteLLM request timeout → 401) is
  what ends the operation; that rejection flows through `renew()` and releases the lock.
- The ONLY timeout-adjacent work is cancellation plumbing (§3 principle 4 / Step 4): an aborted
  request must kill the Python child so it is not leaked. That is tear-down, not a time limit.

---

## 4. Ordered implementation plan

### Step 1 — Rewrite `MemoryLockAdapter` (`packages/js/node/auth/src/storage.ts`)
- Replace the `#tails` promise-chain with a per-key `Map<string, { locked: boolean; queue: Waiter[] }>`
  state machine mirroring `process-lock.ts` (`:88-182`). Pure promise-based waiting; no spin/poll.
- `acquire(key, timeoutMs?)`: if unlocked, mark locked and return a fresh lease id; else push a
  waiter resolver onto the queue and **await it indefinitely by default**. The lease resolves
  only when the waiter is promoted on release.
- **Wait timeout is opt-in, not the default.** When `timeoutMs` is omitted or non-finite
  (`Infinity`), wait forever (no timer created — nothing to leak, nothing to block). When a
  finite `timeoutMs` IS passed, race the queued resolver against a timer; on timeout **remove
  only this waiter from the queue** and reject — never touch the owner or the key entry.
- Change the default budget: `withLock`/`acquireLock` should pass no timeout (indefinite) by
  default. `lockTimeoutSeconds` stays in `AuthOptions` as an opt-in cap for callers that want
  fail-fast, but the default auth path no longer imposes 30s. (Confirm whether to keep the field
  for callers or drop it; recommend keep-as-opt-in.)
- `release(lease)`: ignore unknown/stale leases (mirror `process-lock.ts:147-151`); otherwise
  promote the next queued waiter (handing it a new lease), or drop the key entry when the queue
  is empty.
- Keep the lease-id shape (`${seq}:${key}`) and the existing debug logging.
- `withTimeout` (`storage.ts:90-104`) is only invoked on the opt-in finite-timeout path; keep its
  `/timed out/i` message so any opt-in-timeout test still matches.

### Step 2 — Add the missing regression (`packages/js/node/auth/test/lifecycle.test.ts`)
- **Primary (no-bypass under indefinite wait):** A acquires; C requests the lock and must NOT be
  granted while A holds it (assert C stays pending for a tick); release A; C is then granted.
  This is the core correctness guarantee — the current test at `:97-104` never checks that a
  second waiter is blocked while the holder is still active.
- **No-poison under opt-in timeout:** with a finite `timeoutMs`, A acquires; B times out; **C
  must still remain blocked while A is held** (not acquire in ~1ms); release A; C acquires. This
  is the exact sequence the prior agent reproduced and the existing test misses.
- **Indefinite wait holds:** `acquire(key)` with no timeout stays pending while held and never
  rejects on its own; it resolves only after the holder releases.
- Keep the existing "does not poison the queue" test; it should still pass under the rewrite.

### Step 3 — Provider token acquisition: explicitly NO timeout (`packages/js/node/auth/src/databricks-cli.ts`)
- **Do not add any process timeout** to `databricksCliToken` / `databricksCliLogin` /
  `authenticate` / `refresh`. (Reverses the prior investigation's item 3 per §3.)
- `runProcess` keeps its existing optional `timeoutMs` only for the `--version` probe (`:122`);
  token/login calls pass none. A browser login may take ~15 min and must not be aborted.
- No `tokenTimeoutSeconds` field is added. The lock auto-releases when the action settles via
  `withLock`'s `finally`; the caller (LiteLLM) owns the request budget and surfaces 401 on its
  own timeout.
- Verify the error/success paths still release the lock: on CLI non-zero exit `databricksCliToken`
  throws `AuthError("cli", ...)` (`:183-184`), which propagates through `renew()` → `withLock`
  `finally` → `releaseLock`. No code change expected here beyond confirming the behavior.

### Step 4 — Make the child-process shim cancel (not time out) real work (`projen/shims/python-node/child-process.ts` + `host.ts`)
- Goal is tear-down on cancellation, NOT an imposed timeout (§3 principle 4). Leave the
  `timeoutMs` passed to `pythonHost().process.run` as `undefined` for the token path.
- Honor `AbortSignal` for real: when the signal aborts, actually terminate the Python child so a
  cancelled/abandoned request leaves nothing running. `subprocess.run` on an `asyncio.to_thread`
  worker (`host.ts:243-257`) is not killable, so switch the host process API to a
  `subprocess.Popen` (or `asyncio.create_subprocess_exec`) model that returns a handle and
  supports `kill()`/`terminate()`. Then make `PythonChildProcess.kill()`
  (`child-process.ts:51-53`) forward to it instead of returning `false`, and have the abort
  listener (`:20-27`) call `kill()` before emitting the error.
- This also removes the "leaked live child" problem the prior agent flagged, without introducing
  any time limit.
- Note: an abort only arrives if a caller wires an `AbortSignal` and cancels it. With no caller
  cancellation the child runs to completion (the accepted "hold forever" case).

### Step 5 — Make shim file access async (`projen/shims/python-node/{fs-promises,fs,host}.ts`)
- `fs-promises.unlink` (`fs-promises.ts:91-99`): drop the synchronous
  `pythonHost().file.exists(...)` precheck and rely on the async `remove` + ENOENT translation
  already present.
- `host.ts` async methods: wrap the synchronous `osPath.exists`/`evaluate(...)` calls used
  inside `mkdir` (`:155`), `remove` (`:177-187`) in `toThread(...)` so no blocking Python I/O
  runs on the JS thread. Add an async `existsAsync`-style host helper for internal callers;
  keep the sync `exists`/`readTextSync` **only** for the inherently-synchronous Node APIs
  (`fs.existsSync`, `fs.readFileSync`), which cannot return promises.
- Audit remaining shim call sites so every `async` function path uses the `toThread`-backed
  host methods, never the sync eval shortcuts.

### Step 6 — (Secondary) File-lock protocol alignment (`projen/shims/python-node/file-lock.ts`)
- Only if file storage coordination between Node and Python is a real requirement. Align the
  Python shim to the same on-disk protocol as Node core `proper-lockfile`, or document that the
  two runtimes must not share a lock directory. Lower priority: default storage is Memory.

### Step 7 — Model-proxy concurrency test (through the PythonMonkey binding)
- Add a test that drives concurrent token/catalogue requests through the generated binding (not
  only the pure-TS `lifecycle.test.ts`) to catch regressions in the shim + lock interaction end
  to end. Confirm: with A's CLI token in flight, concurrent callers queue behind the single lock
  holder and do **not** launch a second `databricks auth token` (no bypass). Confirm a cancelled
  caller kills its child and releases the lock.

---

## 5. Validation (per AGENTS.md §Validation)
- Focused tests first: `packages/js/node/auth` (lifecycle + new regression), then the model
  concurrency test, then broaden.
- If any generated config/shim changes, run `bunx projen` twice and confirm the second run is a
  no-diff.
- `bun run version:check` only if versions/workspace change (not expected here).
- Do not fix unrelated failures from the other agent's in-flight docs/release work; report them.

## 6. Coordination notes
- Another agent is actively working the docs/release path (`docs/scripts/generate-api-docs.mjs`,
  `bun run release`, ~v0.9.31). Those files do not overlap this plan's targets (auth, model,
  shims). Avoid committing/pushing or running `release` while that is in flight; expect the tree
  to move between reads.

## 7. Files in scope
- `packages/js/node/auth/src/storage.ts` (rewrite lock as `{ locked, queue }`; indefinite wait)
- `packages/js/node/auth/test/lifecycle.test.ts` (no-bypass + no-poison + indefinite-wait regressions)
- `packages/js/node/auth/src/lifecycle.ts` (pass no wait timeout by default in `withLock`)
- `packages/js/node/auth/src/databricks-cli.ts` (confirm NO token timeout; lock releases on settle)
- `packages/js/node/auth/src/types.ts` (keep `lockTimeoutSeconds` as opt-in; no `tokenTimeoutSeconds`)
- `projen/shims/python-node/child-process.ts` (real abort → kill; no imposed timeout)
- `projen/shims/python-node/host.ts` (killable Popen subprocess handle; async file helpers)
- `projen/shims/python-node/fs-promises.ts`, `fs.ts` (async file access)
- `projen/shims/python-node/file-lock.ts` (secondary, optional)
- `packages/js/node/model` test(s) (concurrency through binding)
