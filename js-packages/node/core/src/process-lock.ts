/**
 * Keyed mutual exclusion across the main thread and its worker threads.
 *
 * {@link withProcessLock} serializes callbacks that share a key: one runs at a
 * time, the rest queue in arrival order, and different keys proceed
 * concurrently. Unlike a plain in-module `Promise` chain, the queue is shared by
 * every thread wired up through {@link processLockWorkerOptions}, so a worker
 * pool cannot run two callbacks for the same key at once.
 *
 * The name says `process`: this coordinates the THREADS of one Node process. It
 * is not cross-process and not cross-host - a second `node` invocation, or a
 * second app replica, has its own coordinator and shares nothing. When the scope
 * is a deployment rather than a process, use
 * `@dbx-tools/postgres`'s `withAdvisoryLock`, which puts the arbiter in
 * PostgreSQL where every replica can see it.
 *
 * The main thread owns the only coordinator. Each participating thread gets one
 * `MessagePort` to it, and a lock is granted by a message back over that port.
 * Consequently:
 *
 *   - the lock is ADVISORY, like Postgres advisory locks - it protects a
 *     critical section only insofar as every writer takes the same key;
 *   - fairness is FIFO per key, since the coordinator queues waiters in the
 *     order their requests arrive;
 *   - a thread that dies while holding a lock releases it, because its port
 *     closing is what hands the key to the next waiter (see
 *     {@link LockCoordinator.removePort}).
 *
 * @module
 */

import {
  isMainThread,
  MessageChannel,
  parentPort,
  workerData,
  type MessagePort,
  type Worker,
  type WorkerOptions,
} from "node:worker_threads";
import { error, hash, object } from "@dbx-tools/shared-core";

/**
 * `workerData` slot carrying the coordinator port into a worker, and the
 * `parentPort` message `type` for the late {@link attachProcessLock} handshake.
 * Namespaced because both travel through channels an application also uses:
 * `workerData` is the caller's own object, and `parentPort` carries the caller's
 * own messages.
 */
const LOCK_PORT_KEY = "__dbxToolsProcessLockPort";
const ATTACH_MESSAGE_TYPE = "__dbxToolsProcessLockAttach";

/** Sent by a client to the coordinator. */
type LockRequest =
  | { type: "acquire"; requestId: string; key: string }
  | { type: "release"; requestId: string; key: string };

/** Sent by the coordinator to the client that now owns the key. */
type LockResponse = { type: "granted"; requestId: string };

type LockMessage = LockRequest | LockResponse;

/** The `parentPort` envelope that hands a late-attached worker its port. */
interface AttachMessage {
  type: typeof ATTACH_MESSAGE_TYPE;
  port: MessagePort;
}

/** One outstanding or granted acquisition. */
interface LockWaiter {
  requestId: string;
  port: MessagePort;
}

/** Shape of the `workerData` slice this module reads. */
interface LockWorkerData {
  [LOCK_PORT_KEY]?: MessagePort;
}

/**
 * A key's owner plus its FIFO queue of waiters.
 *
 * Owner and queue live in ONE map entry rather than two parallel maps so a key
 * cannot end up half-present - a queue whose owner map entry was already deleted
 * would strand its waiters forever, and the entry is dropped only when the key
 * is both unowned and unwanted.
 */
interface LockState {
  owner: LockWaiter;
  queue: LockWaiter[];
}

/**
 * Arbiter for every key, living on the main thread.
 *
 * Holds no timers and no handles of its own: a port is unref'd by its client
 * while idle (see {@link LockClient}), so an idle coordinator never keeps the
 * process alive.
 */
class LockCoordinator {
  private readonly states = new Map<string, LockState>();

  /** Serve one client. Called once per participating thread. */
  addPort(port: MessagePort): void {
    port.on("message", (message: LockMessage) => {
      switch (message.type) {
        case "acquire":
          this.acquire(message.key, message.requestId, port);
          break;
        case "release":
          this.release(message.key, message.requestId);
          break;
        default:
          break;
      }
    });
    // A closed port means its thread exited or was terminated. Releasing here is
    // what keeps one crashed worker from wedging a key for the process lifetime.
    port.on("close", () => this.removePort(port));
    // The coordinator side stays unref'd for its whole life. It is a pure
    // responder - it never has business of its own pending - so keeping the
    // event loop alive for it would mean a process that used a lock once could
    // never exit. A request always arrives from a client that has ref'd ITS
    // port, so the loop is awake whenever there is actually something to serve.
    port.unref();
    port.start();
  }

  private acquire(key: string, requestId: string, port: MessagePort): void {
    const waiter: LockWaiter = { requestId, port };
    const state = this.states.get(key);
    if (!state) {
      this.states.set(key, { owner: waiter, queue: [] });
      grant(waiter);
      return;
    }
    state.queue.push(waiter);
  }

  /**
   * Hand the key on, ignoring a release from anyone but the current owner.
   *
   * A stale release is expected, not defensive coding: an aborted acquisition
   * sends one for a request that never owned the key, and honouring it would
   * revoke the lock from whoever holds it now.
   */
  private release(key: string, requestId: string): void {
    const state = this.states.get(key);
    if (state?.owner.requestId !== requestId) return;
    this.grantNext(key, state);
  }

  /** Promote the next waiter, or drop the key when nobody wants it. */
  private grantNext(key: string, state: LockState): void {
    const next = state.queue.shift();
    if (!next) {
      this.states.delete(key);
      return;
    }
    state.owner = next;
    grant(next);
  }

  /**
   * Drop a dead thread from every key: release the ones it owned and remove it
   * from the queues it was waiting in.
   *
   * Queue removal must happen FIRST. A thread can appear as both the owner of
   * one key and a waiter for another, and promoting it out of a queue it can no
   * longer answer for would grant a lock to a closed port - stalling that key
   * until the process ends.
   */
  private removePort(port: MessagePort): void {
    for (const state of this.states.values()) {
      if (state.queue.length > 0) {
        state.queue = state.queue.filter((waiter) => waiter.port !== port);
      }
    }
    for (const [key, state] of [...this.states]) {
      if (state.owner.port === port) this.grantNext(key, state);
    }
  }
}

/** Notify a waiter that it now owns its key. */
function grant(waiter: LockWaiter): void {
  waiter.port.postMessage({ type: "granted", requestId: waiter.requestId } satisfies LockResponse);
}

/**
 * A thread's end of the conversation: sends requests, awaits grants, and runs
 * callbacks.
 *
 * Owns the event-loop bookkeeping. The port is unref'd while idle so holding a
 * lock module never blocks process exit, and ref'd exactly while this thread has
 * an outstanding request or an unreleased lock - otherwise Node would consider
 * itself out of work and exit mid-critical-section, dropping the grant that was
 * already on its way.
 */
class LockClient {
  private readonly pending = new Map<string, (error?: Error) => void>();
  /** Requests + held locks. The port is ref'd while this is above zero. */
  private active = 0;
  private closed = false;

  constructor(private readonly port: MessagePort) {
    port.on("message", (message: LockMessage) => {
      if (message.type !== "granted") return;
      this.settle(message.requestId);
    });
    port.on("close", () => {
      this.closed = true;
      // The coordinator is gone (main thread exiting, or this worker being torn
      // down). Fail the waiters rather than hang them: a caller blocked on a
      // lock that can never be granted is indistinguishable from a deadlock.
      const closeError = new Error("Process lock port closed before the lock was granted");
      for (const settle of [...this.pending.values()]) settle(closeError);
    });
    port.unref();
    port.start();
  }

  /** Resolve or reject one pending request and drop its ref. */
  private settle(requestId: string, failure?: Error): void {
    const settle = this.pending.get(requestId);
    if (!settle) return;
    this.pending.delete(requestId);
    settle(failure);
  }

  /** Ref the port for the first unit of outstanding work. */
  private retain(): void {
    if (this.active++ === 0) this.port.ref();
  }

  /** Unref once nothing is outstanding, so the thread can exit. */
  private release(): void {
    if (--this.active === 0) this.port.unref();
  }

  async run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error("Process lock port is closed");
    }
    const requestId = hash.id();
    this.retain();
    try {
      await new Promise<void>((resolve, reject) => {
        this.pending.set(requestId, (failure) => (failure ? reject(failure) : resolve()));
        try {
          this.port.postMessage({ type: "acquire", requestId, key } satisfies LockRequest);
        } catch (cause) {
          this.pending.delete(requestId);
          reject(error.toError(cause));
        }
      });
    } catch (cause) {
      // Never granted, so there is nothing to release - just drop the ref.
      this.release();
      throw cause;
    }
    try {
      return await fn();
    } finally {
      // Post before unref'ing: the release must be in flight while the port is
      // still holding the loop open, or the next waiter is stranded.
      if (!this.closed) {
        this.port.postMessage({ type: "release", requestId, key } satisfies LockRequest);
      }
      this.release();
    }
  }
}

/** The coordinator, on the main thread only. */
const coordinator = isMainThread ? new LockCoordinator() : undefined;

/**
 * This thread's client, created on first use.
 *
 * Lazy so importing this module costs nothing and, more importantly, so a worker
 * that never locks anything is never forced to have been started through
 * {@link processLockWorkerOptions}. The main thread wires a channel to its own
 * coordinator; a worker adopts the port it was handed.
 */
let client: LockClient | undefined;

function lockClient(): LockClient {
  if (client) return client;
  if (coordinator) {
    const { port1, port2 } = new MessageChannel();
    coordinator.addPort(port1);
    client = new LockClient(port2);
    return client;
  }
  const port = (workerData as LockWorkerData | undefined)?.[LOCK_PORT_KEY];
  if (!port) {
    throw new Error(
      "This worker has no process-lock port. Start it with processLockWorkerOptions() " +
        "(or call attachProcessLock(worker) and await processLockAttached()).",
    );
  }
  client = new LockClient(port);
  return client;
}

/**
 * Run `fn` while holding the lock named by `key`, releasing it when `fn`
 * settles.
 *
 * Callers sharing a key are serialized across the main thread and every worker
 * started through {@link processLockWorkerOptions}; distinct keys never block
 * each other. Returns whatever `fn` returns and propagates what it throws, so it
 * drops into an existing expression without restructuring.
 *
 * `key` is any value with a stable identity - a string, a `["invoice", id]`
 * tuple, a config object - canonicalized by `object.toStableKey`, the same rule
 * `@dbx-tools/postgres` uses for advisory-lock ids and channel names. Structure
 * is part of the identity: `["invoice", 7]` and `"invoice_7"` are different
 * locks.
 *
 * @example
 * await withProcessLock(["cache", name], async () => {
 *   if (!(await exists(name))) await build(name);
 * });
 */
export function withProcessLock<T>(key: unknown, fn: () => T | Promise<T>): Promise<T> {
  return lockClient().run(lockKey(key), fn);
}

/** Canonical string identity for a lock key (see `object.toStableKey`). */
function lockKey(key: unknown): string {
  return object
    .toOneOrMany(key)
    .map((part) => object.toStableKey(part))
    .join("\u0000");
}

/**
 * Add the coordinator port to a `Worker`'s options so the worker can lock
 * immediately - during module initialization, before any message is handled.
 *
 * Preserves the caller's `workerData` and `transferList`; the port is
 * transferred, as `MessagePort` cannot be cloned.
 *
 * @example
 * new Worker(url, processLockWorkerOptions({ workerData: { tenant } }));
 */
export function processLockWorkerOptions(options: WorkerOptions = {}): WorkerOptions {
  const port = createCoordinatorPort("processLockWorkerOptions");
  const existing = object.isRecord(options.workerData) ? options.workerData : {};
  return {
    ...options,
    workerData: { ...existing, [LOCK_PORT_KEY]: port },
    transferList: [...(options.transferList ?? []), port],
  };
}

/**
 * Wire an ALREADY-RUNNING worker into the lock, for a worker this code did not
 * construct (a pool from a library, say).
 *
 * Prefer {@link processLockWorkerOptions}: the port arrives with a message, so
 * the worker cannot lock during module initialization and must await
 * {@link processLockAttached} first. The worker side needs no other change -
 * `withProcessLock` works normally once the port lands.
 */
export function attachProcessLock(worker: Worker): void {
  const port = createCoordinatorPort("attachProcessLock");
  worker.postMessage({ type: ATTACH_MESSAGE_TYPE, port } satisfies AttachMessage, [port]);
}

/** A fresh coordinator-side channel, or a clear error off the main thread. */
function createCoordinatorPort(caller: string): MessagePort {
  if (!coordinator) {
    throw new Error(`${caller}() must be called from the main thread`);
  }
  const { port1, port2 } = new MessageChannel();
  coordinator.addPort(port1);
  return port2;
}

/**
 * In a worker, resolve once the {@link attachProcessLock} port has arrived.
 *
 * Only needed on the attach path, and safe to await regardless: it returns
 * immediately when the worker already has a port (the
 * {@link processLockWorkerOptions} case) or when called on the main thread, so
 * shared worker code does not branch on how it was started.
 *
 * A `parentPort` listener keeps the worker alive, which is CORRECT here and
 * deliberately not unref'd: this promise is pending work, and a worker allowed to
 * exit while awaiting its port would die silently instead of locking. The
 * listener is removed as soon as the port lands, so the worker is free to exit
 * again the moment the wait is over.
 */
export function processLockAttached(): Promise<void> {
  if (isMainThread || client || (workerData as LockWorkerData | undefined)?.[LOCK_PORT_KEY]) {
    return Promise.resolve();
  }
  const port = parentPort;
  if (!port) {
    return Promise.reject(new Error("processLockAttached() must be called from a worker thread"));
  }
  return new Promise<void>((resolve) => {
    const onMessage = (message: unknown): void => {
      if (!object.isRecord(message) || message.type !== ATTACH_MESSAGE_TYPE) return;
      port.off("message", onMessage);
      client = new LockClient((message as unknown as AttachMessage).port);
      resolve();
    };
    port.on("message", onMessage);
  });
}
