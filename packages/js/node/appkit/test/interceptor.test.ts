import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, describe, it } from "node:test";
import {
  createInterceptorContext,
  type BindableProcess,
  type LifecycleEvent,
} from "../src/interceptor.ts";

/**
 * A stand-in for a `ChildProcess`: an `EventEmitter` with the {@link BindableProcess}
 * surface, recording the signals it was killed with. `emitExit` fires the `exit`
 * event `bindProcess` listens for.
 */
class FakeChild extends EventEmitter implements BindableProcess {
  pid = Math.floor(Math.random() * 100000);
  killed = false;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    if (typeof signal === "string") this.signals.push(signal);
    return true;
  }

  emitExit(code: number | null): void {
    this.emit("exit", code);
  }
}

// bindProcess installs process signal listeners lazily; strip them between tests
// so a test's SIGTERM/SIGINT handlers don't leak into the next.
afterEach(() => {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.removeAllListeners(sig);
  }
});

describe("bindProcess teardown", () => {
  it("kills every OTHER bound child when one exits", () => {
    const { context } = createInterceptorContext({});
    const a = new FakeChild();
    const b = new FakeChild();
    context.bindProcess(a);
    context.bindProcess(b);

    // `a` dies -> the supervisor should SIGTERM the survivors (`b`).
    a.emitExit(1);

    assert.equal(b.killed, true);
    assert.deepEqual(b.signals, ["SIGTERM"]);
  });

  it("is idempotent: a second exit does not re-kill", () => {
    const { context } = createInterceptorContext({});
    const a = new FakeChild();
    const b = new FakeChild();
    context.bindProcess(a);
    context.bindProcess(b);

    a.emitExit(1);
    b.signals.length = 0; // clear the first teardown's kill
    b.emitExit(1); // second exit after shutdown started

    assert.deepEqual(b.signals, []); // guard prevents a repeat teardown
  });

  it("tears down children bound through different interceptor contexts", () => {
    const first = createInterceptorContext({});
    const second = createInterceptorContext({});
    const a = new FakeChild();
    const b = new FakeChild();
    first.context.bindProcess(a);
    second.context.bindProcess(b);

    a.emitExit(1);

    assert.deepEqual(b.signals, ["SIGTERM"]);
  });

  it("runs shared teardown handlers before killing children", () => {
    const first = createInterceptorContext({});
    const second = createInterceptorContext({});
    const a = new FakeChild();
    const seen: string[] = [];
    first.context.onTeardown(() => seen.push("first"));
    second.context.onTeardown(() => seen.push("second"));
    first.context.bindProcess(a);

    a.emitExit(1);

    assert.deepEqual(seen, ["first", "second"]);
  });
});

describe("broadcastSignal", () => {
  it("passes the signal through to every bound child", () => {
    const { context } = createInterceptorContext({});
    const a = new FakeChild();
    const b = new FakeChild();
    context.bindProcess(a);
    context.bindProcess(b);

    context.broadcastSignal("SIGINT");

    assert.deepEqual(a.signals, ["SIGINT"]);
    assert.deepEqual(b.signals, ["SIGINT"]);
  });
});

describe("onTeardown", () => {
  it("installs process signal handling without a bound child", () => {
    const { context } = createInterceptorContext({});

    context.onTeardown(() => {});

    assert.ok(process.listenerCount("SIGTERM") > 0);
  });
});

describe("lifecycle", () => {
  it("invokes handlers registered for the emitted event", async () => {
    const { context, emitLifecycle } = createInterceptorContext({});
    const seen: LifecycleEvent[] = [];
    context.onLifecycle("shutdown", () => void seen.push("shutdown"));
    context.onLifecycle("server:ready", () => void seen.push("server:ready"));

    await emitLifecycle("shutdown");

    assert.deepEqual(seen, ["shutdown"]); // only the matching handler ran
  });

  it("swallows a failing handler and still runs its siblings", async () => {
    const { context, emitLifecycle } = createInterceptorContext({});
    const ran: string[] = [];
    context.onLifecycle("shutdown", () => {
      throw new Error("boom");
    });
    context.onLifecycle("shutdown", () => void ran.push("second"));

    await assert.doesNotReject(emitLifecycle("shutdown"));
    assert.deepEqual(ran, ["second"]);
  });
});

describe("env", () => {
  it("exposes the resolved env passed in", () => {
    const { context } = createInterceptorContext({
      databricksHost: "https://example.databricks.com",
    });
    assert.equal(context.env.databricksHost, "https://example.databricks.com");
  });
});
