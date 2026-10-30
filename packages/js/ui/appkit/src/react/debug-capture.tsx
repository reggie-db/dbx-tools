import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
  usePluginClientConfig,
} from "@databricks/appkit-ui/react";
import {
  DEBUG_CAPTURE_PLUGIN_NAME,
  DebugCaptureClientConfigSchema,
  DebugCaptureStartResponseSchema,
  DebugCaptureStopResponseSchema,
  debugCaptureRoute,
  type DebugCaptureEvent,
  type DebugCaptureScalar,
} from "@dbx-tools/shared-appkit/debug";
import { BugIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { copyText } from "./clipboard.ts";

const ACTIVE_CAPTURE_STORAGE_KEY = "dbx-tools.browser-debug-capture";
const MAX_BUFFERED_EVENTS = 40;
const FLUSH_INTERVAL_MS = 500;

const DEFAULT_DOCUMENT_EVENTS = [
  "animationend",
  "animationstart",
  "beforeinput",
  "change",
  "click",
  "compositionend",
  "compositionstart",
  "compositionupdate",
  "contextmenu",
  "dblclick",
  "dragover",
  "dragstart",
  "drop",
  "focusin",
  "focusout",
  "fullscreenchange",
  "input",
  "keydown",
  "keyup",
  "pointercancel",
  "pointerdown",
  "pointermove",
  "pointerup",
  "scroll",
  "selectionchange",
  "submit",
  "touchcancel",
  "touchend",
  "touchmove",
  "touchstart",
  "transitionend",
  "transitionstart",
  "visibilitychange",
  "wheel",
] as const;

const DEFAULT_WINDOW_EVENTS = [
  "hashchange",
  "offline",
  "online",
  "orientationchange",
  "pageshow",
  "popstate",
  "resize",
  "scroll",
] as const;

/** A named element included in each browser debug snapshot. */
export interface BrowserDebugCaptureTarget {
  /** CSS selector resolved whenever a snapshot is recorded. */
  selector: string;
  /** Dataset keys copied into the snapshot. */
  dataset?: readonly string[];
  /** Whether scroll dimensions and offsets are copied. */
  scroll?: boolean;
  /** Inline CSS custom properties or standard properties copied into the snapshot. */
  styleProperties?: readonly string[];
}

/** Browser debug recorder configuration. */
export interface UseBrowserDebugCaptureOptions {
  /** Application version included in capture metadata. */
  appVersion?: string;
  /** Additional bounded scalar metadata included when a capture starts. */
  metadata?: Readonly<Record<string, DebugCaptureScalar>>;
  /** Named component elements measured in every snapshot. */
  targets?: Readonly<Record<string, string | BrowserDebugCaptureTarget>>;
}

/** Browser debug recorder state and controls. */
export interface BrowserDebugCaptureState {
  available: boolean;
  captureId: string | null;
  error: string | null;
  phase: "idle" | "starting" | "recording" | "stopping";
  startCapture(): Promise<string | null>;
  stopCapture(): Promise<string | null>;
}

function storedCaptureId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(ACTIVE_CAPTURE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setStoredCaptureId(captureId: string | null): void {
  try {
    if (captureId) window.sessionStorage.setItem(ACTIVE_CAPTURE_STORAGE_KEY, captureId);
    else window.sessionStorage.removeItem(ACTIVE_CAPTURE_STORAGE_KEY);
  } catch {
    // Recording remains usable when session storage is unavailable.
  }
}

function targetConfig(target: string | BrowserDebugCaptureTarget): BrowserDebugCaptureTarget {
  return typeof target === "string" ? { selector: target } : target;
}

function snapshotKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+(.)?/g, (_, next: string | undefined) =>
    next ? next.toUpperCase() : "",
  );
}

function addRect(
  data: Record<string, DebugCaptureScalar>,
  prefix: string,
  element: Element | null,
): void {
  if (!element) return;
  const rect = element.getBoundingClientRect();
  data[`${prefix}Top`] = rect.top;
  data[`${prefix}Bottom`] = rect.bottom;
  data[`${prefix}Height`] = rect.height;
  data[`${prefix}Left`] = rect.left;
  data[`${prefix}Right`] = rect.right;
  data[`${prefix}Width`] = rect.width;
}

function describeElement(element: Element | null): string | null {
  if (!element) return null;
  return (
    element.getAttribute("data-slot") ??
    element.getAttribute("aria-label") ??
    element.id ??
    element.tagName.toLowerCase()
  );
}

function readSnapshot(
  targets: Readonly<Record<string, string | BrowserDebugCaptureTarget>>,
): Record<string, DebugCaptureScalar> {
  const visualViewport = window.visualViewport;
  const data: Record<string, DebugCaptureScalar> = {
    activeElement: describeElement(document.activeElement),
    bodyScrollTop: document.body.scrollTop,
    devicePixelRatio: window.devicePixelRatio,
    documentScrollTop: document.documentElement.scrollTop,
    fullscreen: document.fullscreenElement !== null,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    keyboardInset: visualViewport ? Math.max(0, window.innerHeight - visualViewport.height) : 0,
    online: window.navigator.onLine,
    orientationAngle: window.screen.orientation?.angle ?? null,
    orientationType: window.screen.orientation?.type ?? "unknown",
    screenHeight: window.screen.height,
    screenWidth: window.screen.width,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    visibility: document.visibilityState,
  };
  if (visualViewport) {
    data.visualHeight = visualViewport.height;
    data.visualWidth = visualViewport.width;
    data.visualOffsetLeft = visualViewport.offsetLeft;
    data.visualOffsetTop = visualViewport.offsetTop;
    data.visualPageLeft = visualViewport.pageLeft;
    data.visualPageTop = visualViewport.pageTop;
    data.visualScale = visualViewport.scale;
  }
  addRect(data, "body", document.body);
  for (const [name, target] of Object.entries(targets)) {
    const config = targetConfig(target);
    const element = document.querySelector<HTMLElement>(config.selector);
    const prefix = snapshotKey(name);
    addRect(data, prefix, element);
    if (!element) continue;
    if (config.scroll) {
      data[`${prefix}ClientHeight`] = element.clientHeight;
      data[`${prefix}ClientWidth`] = element.clientWidth;
      data[`${prefix}ScrollHeight`] = element.scrollHeight;
      data[`${prefix}ScrollLeft`] = element.scrollLeft;
      data[`${prefix}ScrollTop`] = element.scrollTop;
      data[`${prefix}ScrollWidth`] = element.scrollWidth;
      data[`${prefix}BottomDistance`] =
        element.scrollHeight - element.scrollTop - element.clientHeight;
    }
    for (const key of config.dataset ?? []) {
      data[`${prefix}Data${snapshotKey(key)}`] = element.dataset[key] ?? null;
    }
    for (const property of config.styleProperties ?? []) {
      data[`${prefix}Style${snapshotKey(property)}`] = element.style.getPropertyValue(property);
    }
  }
  return data;
}

function keyboardValue(event: KeyboardEvent): string {
  return event.key.length === 1 ? "[printable]" : event.key;
}

function eventData(event: Event): Record<string, DebugCaptureScalar> {
  const pointer = event instanceof PointerEvent ? event : null;
  const touch = event instanceof TouchEvent ? event.changedTouches[0] : null;
  const keyboard = event instanceof KeyboardEvent ? event : null;
  const input = event instanceof InputEvent ? event : null;
  const wheel = event instanceof WheelEvent ? event : null;
  return {
    defaultPrevented: event.defaultPrevented,
    eventTarget: describeElement(event.target instanceof Element ? event.target : null),
    inputType: input?.inputType ?? null,
    key: keyboard ? keyboardValue(keyboard) : null,
    metaKey: keyboard?.metaKey ?? pointer?.metaKey ?? null,
    pointerButtons: pointer?.buttons ?? null,
    pointerId: pointer?.pointerId ?? null,
    pointerType: pointer?.pointerType ?? null,
    pointerX: pointer?.clientX ?? null,
    pointerY: pointer?.clientY ?? null,
    shiftKey: keyboard?.shiftKey ?? pointer?.shiftKey ?? null,
    touchX: touch?.clientX ?? null,
    touchY: touch?.clientY ?? null,
    wheelDeltaX: wheel?.deltaX ?? null,
    wheelDeltaY: wheel?.deltaY ?? null,
  };
}

/** Record browser diagnostics through the optional AppKit debug-capture plugin. */
export function useBrowserDebugCapture(
  options: UseBrowserDebugCaptureOptions = {},
): BrowserDebugCaptureState {
  const published = usePluginClientConfig<unknown>(DEBUG_CAPTURE_PLUGIN_NAME);
  const clientConfig = useMemo(() => {
    const parsed = DebugCaptureClientConfigSchema.safeParse(published);
    return parsed.success ? parsed.data : null;
  }, [published]);
  const route = clientConfig ? debugCaptureRoute(clientConfig.basePath) : null;
  const restoredCaptureId = useMemo(storedCaptureId, []);
  const [captureId, setCaptureId] = useState<string | null>(restoredCaptureId);
  const [phase, setPhase] = useState<BrowserDebugCaptureState["phase"]>(
    restoredCaptureId ? "recording" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const captureIdRef = useRef(captureId);
  const recordingRef = useRef(captureId !== null);
  const startedAtRef = useRef(typeof performance === "undefined" ? 0 : performance.now());
  const sequenceRef = useRef(0);
  const eventsRef = useRef<DebugCaptureEvent[]>([]);
  const pendingRequestRef = useRef<Promise<void>>(Promise.resolve());
  const targets = options.targets ?? {};
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  const post = useCallback(
    async (body: unknown): Promise<Response> => {
      if (!route) throw new Error("Browser debug capture is not enabled by the AppKit server.");
      const response = await fetch(route, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error(`Debug capture request failed (${response.status}).`);
      return response;
    },
    [route],
  );

  const record = useCallback((type: string, extra: Record<string, DebugCaptureScalar> = {}) => {
    if (!recordingRef.current) return;
    eventsRef.current.push({
      at: performance.now() - startedAtRef.current,
      data: { ...readSnapshot(targetsRef.current), ...extra },
      sequence: sequenceRef.current++,
      type,
    });
  }, []);

  const flush = useCallback((): Promise<void> => {
    const activeCaptureId = captureIdRef.current;
    if (!activeCaptureId || eventsRef.current.length === 0) return pendingRequestRef.current;
    const events = eventsRef.current.splice(0, MAX_BUFFERED_EVENTS);
    const request = pendingRequestRef.current
      .catch(() => undefined)
      .then(async () => {
        await post({ action: "append", captureId: activeCaptureId, events });
      })
      .catch((requestError: unknown) => {
        setError(requestError instanceof Error ? requestError.message : "Debug capture failed.");
      });
    pendingRequestRef.current = request;
    return request;
  }, [post]);

  useEffect(() => {
    if (phase !== "recording" || !route) return;
    recordingRef.current = true;
    captureIdRef.current = captureId;
    record(restoredCaptureId === captureId ? "capture-resume" : "capture-ready");

    let sampleFrame = 0;
    let pendingType = "layout";
    let pendingData: Record<string, DebugCaptureScalar> = {};
    const sample = (type: string, data: Record<string, DebugCaptureScalar> = {}) => {
      pendingType = type;
      pendingData = data;
      if (sampleFrame !== 0) return;
      sampleFrame = window.requestAnimationFrame(() => {
        sampleFrame = 0;
        record(pendingType, pendingData);
        if (eventsRef.current.length >= MAX_BUFFERED_EVENTS) void flush();
      });
    };
    const listener = (event: Event) => sample(`browser-${event.type}`, eventData(event));
    const listeners: Array<[EventTarget, string, EventListener, boolean]> = [];
    const listen = (target: EventTarget | null, eventName: string, capture = false) => {
      if (!target) return;
      target.addEventListener(eventName, listener, { capture, passive: true });
      listeners.push([target, eventName, listener, capture]);
    };
    for (const eventName of DEFAULT_DOCUMENT_EVENTS) listen(document, eventName, true);
    for (const eventName of DEFAULT_WINDOW_EVENTS) listen(window, eventName);
    listen(window.visualViewport, "resize");
    listen(window.visualViewport, "scroll");
    listen(window.visualViewport, "scrollend");

    const resizeObserver = new ResizeObserver(() => sample("element-resize"));
    for (const target of Object.values(targetsRef.current)) {
      const element = document.querySelector(targetConfig(target).selector);
      if (element) resizeObserver.observe(element);
    }
    resizeObserver.observe(document.body);

    const interval = window.setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    const handlePageHide = () => {
      record("page-hide");
      const activeCaptureId = captureIdRef.current;
      const events = eventsRef.current.splice(0, MAX_BUFFERED_EVENTS);
      if (!activeCaptureId || events.length === 0) return;
      navigator.sendBeacon(
        route,
        new Blob([JSON.stringify({ action: "append", captureId: activeCaptureId, events })], {
          type: "application/json",
        }),
      );
    };
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      if (sampleFrame !== 0) window.cancelAnimationFrame(sampleFrame);
      window.clearInterval(interval);
      window.removeEventListener("pagehide", handlePageHide);
      for (const [target, eventName, eventListener, capture] of listeners) {
        target.removeEventListener(eventName, eventListener, capture);
      }
      resizeObserver.disconnect();
    };
  }, [captureId, flush, phase, record, restoredCaptureId, route]);

  const startCapture = useCallback(async (): Promise<string | null> => {
    if (phase !== "idle" || !route) return null;
    setError(null);
    setPhase("starting");
    try {
      const response = await post({
        action: "start",
        metadata: {
          ...options.metadata,
          appVersion: options.appVersion ?? "unknown",
          devicePixelRatio: window.devicePixelRatio,
          path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
          screenHeight: window.screen.height,
          screenWidth: window.screen.width,
        },
      });
      const result = DebugCaptureStartResponseSchema.parse(await response.json());
      captureIdRef.current = result.captureId;
      recordingRef.current = true;
      startedAtRef.current = performance.now();
      sequenceRef.current = 0;
      eventsRef.current = [];
      setStoredCaptureId(result.captureId);
      setCaptureId(result.captureId);
      setPhase("recording");
      return result.captureId;
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Could not start capture.");
      setPhase("idle");
      return null;
    }
  }, [options.appVersion, options.metadata, phase, post, route]);

  const stopCapture = useCallback(async (): Promise<string | null> => {
    const activeCaptureId = captureIdRef.current;
    if (!activeCaptureId || phase !== "recording") return null;
    record("capture-stop-requested");
    recordingRef.current = false;
    setPhase("stopping");
    const events = eventsRef.current.splice(0);
    await pendingRequestRef.current.catch(() => undefined);
    try {
      const response = await post({ action: "stop", captureId: activeCaptureId, events });
      DebugCaptureStopResponseSchema.parse(await response.json());
      setStoredCaptureId(null);
      captureIdRef.current = null;
      setCaptureId(null);
      setError(null);
      setPhase("idle");
      return activeCaptureId;
    } catch (stopError) {
      recordingRef.current = true;
      setError(stopError instanceof Error ? stopError.message : "Could not stop capture.");
      setPhase("recording");
      return null;
    }
  }, [phase, post, record]);

  return {
    available: route !== null,
    captureId,
    error,
    phase,
    startCapture,
    stopCapture,
  };
}

/** Props for the reusable AppKit browser debug-capture button. */
export interface BrowserDebugCaptureButtonProps extends UseBrowserDebugCaptureOptions {
  className?: string;
}

/** Toggle browser diagnostics and copy the completed capture identifier. */
export function BrowserDebugCaptureButton({
  className,
  ...options
}: BrowserDebugCaptureButtonProps) {
  const { available, captureId, error, phase, startCapture, stopCapture } =
    useBrowserDebugCapture(options);
  const recording = phase === "recording";
  const busy = phase === "starting" || phase === "stopping";

  if (!available) return null;

  const tooltip = error
    ? error
    : recording
      ? "Stop browser capture and copy ID"
      : "Start browser debug capture";

  const toggle = (button: HTMLButtonElement) => {
    button.blur();
    if (!recording || !captureId) {
      void startCapture();
      return;
    }
    // Begin the clipboard write inside the original iOS tap gesture.
    void copyText(captureId);
    void stopCapture();
  };

  return (
    <div className="relative flex shrink-0 items-center">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={busy}
              aria-label={recording ? "Stop browser capture and copy ID" : "Start browser capture"}
              aria-pressed={recording}
              data-capture-id={captureId ?? undefined}
              data-capture-state={phase}
              className={cn(
                "relative size-8",
                recording && "bg-destructive/15 text-destructive hover:bg-destructive/25",
                error && "text-destructive",
                className,
              )}
              onClick={(event) => toggle(event.currentTarget)}
            >
              <BugIcon className="size-4" />
              {recording ? (
                <span className="absolute right-1 top-1 size-1.5 rounded-full bg-destructive" />
              ) : null}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
