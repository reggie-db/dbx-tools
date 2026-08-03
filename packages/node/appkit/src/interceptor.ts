/**
 * The `createApp` INTERCEPTOR context: an in-process handle an app hands to
 * add-ons (the tunnel, chiefly) so they can read the env auto-configuration
 * computed, hook AppKit's lifecycle, and supervise sibling child processes as one
 * unit - concurrently-style, where any death takes the whole set down.
 *
 * An interceptor is a plain function `(ctx) => void | Promise<void>` passed to
 * {@link CreateAppConfig.interceptor} ("one or many"). {@link createApp} runs each
 * one AFTER auto-configuration has populated `process.env` but as part of booting
 * the app, so an interceptor sees the resolved connection and can bind processes
 * before or during setup.
 *
 * The names here mirror AppKit's own vocabulary rather than inventing parallel
 * ones: {@link LifecycleEvent} and {@link InterceptorContext.onLifecycle} are the
 * exact shape of `PluginContext.onLifecycle` (`setup:complete` / `server:ready` /
 * `shutdown`). The bridge that makes that hook reachable from OUTSIDE a plugin -
 * where interceptors run - is {@link lifecycleBridge}, a tiny internal plugin
 * {@link createApp} injects to capture `this.context` and relay its events.
 *
 * @module
 */

import type { ChildProcess } from "node:child_process";
import { Plugin, toPlugin, type BasePluginConfig, type PluginManifest } from "@databricks/appkit";
import { log } from "@dbx-tools/shared-core";
import type { LakebaseConnection } from "./lakebase-resolver.ts";

const logger = log.logger("interceptor");

/**
 * AppKit's plugin-lifecycle events, verbatim from `PluginContext`
 * (`node_modules/@databricks/appkit/.../core/plugin-context.d.ts`). Re-declared
 * structurally rather than imported because `PluginContext` is not in the
 * package's `exports` map (the same reason {@link PluginContextLike} exists in
 * `./plugin`).
 *
 * - `setup:complete` - every plugin's `setup()` has resolved.
 * - `server:ready` - the `server()` plugin is listening (never fires for a
 *   serverless app, e.g. the tunnel gate).
 * - `shutdown` - the app is tearing down.
 */
export type LifecycleEvent = "setup:complete" | "server:ready" | "shutdown";

/** A lifecycle subscriber. Errors are logged, not propagated (matches AppKit). */
export type LifecycleHandler = () => void | Promise<void>;

/**
 * The env auto-configuration resolved before boot, exposed to interceptors so
 * they read COMPUTED values instead of re-reading `process.env` themselves.
 *
 * `lakebase` is the resolved Postgres connection when Lakebase auto-config ran
 * (see `create-app`'s `autoConfigure`), else `undefined`. `databricksHost` is the
 * workspace host as resolved into the environment (`DATABRICKS_HOST`), which the
 * tunnel interceptor both reads and, when it must, sets.
 */
export interface ResolvedAppEnv {
  /** Resolved Lakebase connection, when auto-config resolved one. */
  readonly lakebase?: LakebaseConnection;
  /** Resolved Databricks workspace host (`DATABRICKS_HOST`), when known. */
  readonly databricksHost?: string;
}

/**
 * A process {@link InterceptorContext.bindProcess} can supervise. A bare
 * `node:child_process` `ChildProcess` (e.g. portr) satisfies this, and so does
 * `@dbx-tools/core`'s `spawn()` result (a `ChildProcessResult` IS a
 * `ChildProcess`) - one code path handles both.
 */
export type BindableProcess = Pick<ChildProcess, "pid" | "kill" | "killed" | "once">;

/**
 * The handle passed to each interceptor.
 *
 * @example
 * import { createApp } from "@dbx-tools/appkit";
 *
 * await createApp({
 *   plugins: [server()],
 *   interceptor: (ctx) => {
 *     const portr = spawnPortr(ctx.env.databricksHost);
 *     ctx.bindProcess(portr);            // app <-> portr live/die together
 *     ctx.onLifecycle("shutdown", () => portr.kill("SIGTERM"));
 *   },
 * });
 */
export interface InterceptorContext {
  /** The env auto-configuration computed before boot. */
  readonly env: ResolvedAppEnv;
  /**
   * Subscribe to an AppKit lifecycle event. Mirrors `PluginContext.onLifecycle`;
   * the injected {@link lifecycleBridge} relays the real events here once the app
   * boots. A handler registered for an event that already fired is NOT called
   * retroactively (same semantics as AppKit).
   */
  onLifecycle(event: LifecycleEvent, fn: LifecycleHandler): void;
  /**
   * Broadcast a termination signal from the main app to every bound process.
   * Called automatically when this process receives `SIGINT`/`SIGTERM`/`SIGHUP`;
   * exposed so an interceptor can trigger teardown itself.
   */
  broadcastSignal(signal: NodeJS.Signals): void;
  /**
   * Supervise a child process alongside the app, concurrently-style: signals pass
   * through, and if EITHER the child or the app dies the whole set comes down.
   * Generalizes the tunnel's old hand-rolled `superviseExit`. Safe to call for
   * several children; teardown is idempotent.
   */
  bindProcess(child: BindableProcess): void;
}

/** A single interceptor, or several. The `createApp` `interceptor?:` option. */
export type Interceptor = (ctx: InterceptorContext) => void | Promise<void>;

/** How long bound children get to exit on `SIGTERM` before the app force-exits. */
const TEARDOWN_GRACE_MS = 3000;

/** The signals that trigger teardown when the MAIN process receives them. */
const TEARDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * The mutable machinery behind an {@link InterceptorContext}. Split out so
 * {@link createInterceptorContext} can hand the public context to interceptors
 * while `create-app` retains the `emitLifecycle` side-channel the bridge drives.
 */
export interface InterceptorRuntime {
  /** The context handed to each interceptor. */
  readonly context: InterceptorContext;
  /** Fire a lifecycle event to every subscriber (called by {@link lifecycleBridge}). */
  emitLifecycle(event: LifecycleEvent): Promise<void>;
}

/**
 * Build an {@link InterceptorContext} + its {@link InterceptorRuntime}.
 *
 * Teardown is the generalized `superviseExit`: the first child exit or main-process
 * termination signal flips a one-shot guard, `SIGTERM`s the other bound children,
 * then `process.exit`s after {@link TEARDOWN_GRACE_MS} (an `unref`'d timer, so it
 * never itself holds the loop open). The process-signal listeners are installed
 * lazily on the first `bindProcess` so an app that binds nothing is untouched.
 */
export function createInterceptorContext(env: ResolvedAppEnv): InterceptorRuntime {
  const handlers = new Map<LifecycleEvent, LifecycleHandler[]>();
  const children = new Set<BindableProcess>();
  let shuttingDown = false;
  let signalsBound = false;

  const teardown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) child.kill("SIGTERM");
    }
    setTimeout(() => process.exit(code), TEARDOWN_GRACE_MS).unref();
  };

  const broadcastSignal = (signal: NodeJS.Signals): void => {
    for (const child of children) {
      if (!child.killed) child.kill(signal);
    }
    teardown(0);
  };

  const bindProcessSignals = (): void => {
    if (signalsBound) return;
    signalsBound = true;
    for (const signal of TEARDOWN_SIGNALS) {
      process.on(signal, () => broadcastSignal(signal));
    }
  };

  const bindProcess = (child: BindableProcess): void => {
    bindProcessSignals();
    children.add(child);
    child.once("exit", (code) => {
      logger.warn("bound process exited; tearing down the app", { code });
      teardown(typeof code === "number" ? code : 1);
    });
  };

  const onLifecycle = (event: LifecycleEvent, fn: LifecycleHandler): void => {
    const list = handlers.get(event);
    if (list) list.push(fn);
    else handlers.set(event, [fn]);
  };

  const emitLifecycle = async (event: LifecycleEvent): Promise<void> => {
    const list = handlers.get(event);
    if (!list) return;
    for (const fn of list) {
      try {
        await fn();
      } catch (error) {
        // Match AppKit: a failing lifecycle handler is logged, never fatal, and
        // never blocks its siblings.
        logger.warn("lifecycle handler failed", { event, error });
      }
    }
  };

  const context: InterceptorContext = {
    env,
    onLifecycle,
    broadcastSignal,
    bindProcess,
  };

  return { context, emitLifecycle };
}

/** Config for {@link LifecycleBridgePlugin}: the sink its captured events flow to. */
interface LifecycleBridgeConfig extends BasePluginConfig {
  /** The runtime whose `emitLifecycle` receives the real AppKit events. */
  runtime?: InterceptorRuntime;
}

/**
 * Structural shape of the `PluginContext.onLifecycle` we bridge. Mirrors only the
 * one method we touch (like {@link PluginContextLike} in `./plugin`), since
 * AppKit's `PluginContext` is not importable from the package's `exports`.
 */
interface LifecycleContextLike {
  onLifecycle(event: LifecycleEvent, fn: LifecycleHandler): void;
}

function hasOnLifecycle(context: unknown): context is LifecycleContextLike {
  return typeof (context as LifecycleContextLike | undefined)?.onLifecycle === "function";
}

/**
 * The internal plugin {@link createApp} injects to make AppKit's lifecycle
 * reachable from interceptor code. On `setup()` it reads its own `this.context`
 * (the real `PluginContext`) and forwards each {@link LifecycleEvent} to the
 * interceptor runtime, so `ctx.onLifecycle(...)` handlers fire on the genuine
 * events. It owns no routes, config surface, or exports.
 */
export class LifecycleBridgePlugin extends Plugin<LifecycleBridgeConfig> {
  static manifest = {
    name: "dbxToolsLifecycleBridge",
    displayName: "Lifecycle Bridge",
    description: "Relays AppKit lifecycle events to the createApp interceptor context.",
    stability: "beta",
    hidden: true,
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<"dbxToolsLifecycleBridge">;

  override async setup(): Promise<void> {
    const runtime = this.config.runtime;
    if (!runtime) return;
    if (!hasOnLifecycle(this.context)) {
      logger.debug("no PluginContext.onLifecycle to bridge; interceptor lifecycle events inert");
      return;
    }
    const events: LifecycleEvent[] = ["setup:complete", "server:ready", "shutdown"];
    for (const event of events) {
      this.context.onLifecycle(event, () => runtime.emitLifecycle(event));
    }
  }
}

/** Factory for the injected {@link LifecycleBridgePlugin}. */
export const lifecycleBridge = toPlugin(LifecycleBridgePlugin);
