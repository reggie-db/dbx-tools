import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { autosizeComposerTextarea, observeComposerWidth } from "../src/react/_composer-autosize.ts";

function sizingFixture() {
  let width = 0;
  let scrollHeight = 64;
  let height = "432px";
  const assignments: string[] = [];
  const group = {
    getBoundingClientRect: () => ({ width }),
  } as unknown as HTMLElement;
  const textarea = {
    get scrollHeight() {
      return scrollHeight;
    },
    style: {
      get height() {
        return height;
      },
      set height(value: string) {
        height = value;
        assignments.push(value);
      },
    },
  } as HTMLTextAreaElement;
  return {
    group,
    textarea,
    assignments,
    height: () => height,
    setWidth: (value: number) => {
      width = value;
    },
    setScrollHeight: (value: number) => {
      scrollHeight = value;
    },
  };
}

describe("composer textarea autosizing", () => {
  it("waits for usable width and resets before every measurement", () => {
    const fixture = sizingFixture();

    autosizeComposerTextarea(fixture.group, fixture.textarea);
    assert.equal(fixture.height(), "432px");
    assert.deepEqual(fixture.assignments, []);

    fixture.setWidth(480);
    autosizeComposerTextarea(fixture.group, fixture.textarea);
    assert.equal(fixture.height(), "64px");
    assert.deepEqual(fixture.assignments, ["auto", "64px"]);

    fixture.setScrollHeight(144);
    autosizeComposerTextarea(fixture.group, fixture.textarea);
    assert.equal(fixture.height(), "144px");
    assert.deepEqual(fixture.assignments.slice(-2), ["auto", "144px"]);
  });

  it("remeasures a reopened container at the same prior width and disconnects", () => {
    const group = {} as HTMLElement;
    let callback!: ResizeObserverCallback;
    let observerInstance!: TestResizeObserver;

    class TestResizeObserver {
      observed?: Element;
      disconnected = false;

      constructor(next: ResizeObserverCallback) {
        callback = next;
        observerInstance = this;
      }

      observe(target: Element): void {
        this.observed = target;
      }

      disconnect(): void {
        this.disconnected = true;
      }
    }

    let resizeCalls = 0;
    const cleanup = observeComposerWidth(
      group,
      () => {
        resizeCalls++;
      },
      TestResizeObserver as unknown as typeof ResizeObserver,
    );
    const notify = (width: number) =>
      callback(
        [{ contentRect: { width } } as ResizeObserverEntry],
        observerInstance as unknown as ResizeObserver,
      );

    notify(0);
    notify(480);
    notify(480);
    assert.equal(resizeCalls, 1);
    assert.equal(observerInstance.observed, group);

    notify(0);
    notify(480);
    assert.equal(resizeCalls, 2);

    cleanup();
    assert.equal(observerInstance.disconnected, true);
  });

  it("degrades to direct input measurements without ResizeObserver", () => {
    const cleanup = observeComposerWidth({} as HTMLElement, () => assert.fail(), undefined);

    assert.doesNotThrow(cleanup);
  });
});
