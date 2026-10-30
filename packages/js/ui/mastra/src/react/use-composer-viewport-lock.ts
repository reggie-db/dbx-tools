import { useLayoutEffect, type RefObject } from "react";
import { ScrollBooster } from "scrollbooster";

const COMPOSER_DOCK_SELECTOR = '[data-slot="aui_composer-dock"]';
const COMPOSER_INPUT_SELECTOR = ".aui-composer-input";
const TRANSCRIPT_SELECTOR = '[data-slot="aui_thread-viewport"]';
const TRANSCRIPT_CONTENT_SELECTOR = '[data-slot="aui_thread-content"]';
const TRANSCRIPT_INDICATOR_SELECTOR = '[data-slot="aui_thread-scroll-indicator"]';

const SCROLL_BOUNDARY_EPSILON_PX = 1;
const KEYBOARD_GEOMETRY_THRESHOLD_PX = 80;
const FOCUS_GUARD_FALLBACK_MS = 600;
const FOCUS_GUARD_SETTLE_MS = 120;
const MIN_SCROLL_INDICATOR_HEIGHT_PX = 28;

/** Internal event used by the scroll-to-bottom control to cancel iOS drag momentum first. */
export const CANCEL_TRANSCRIPT_KINETIC_SCROLL_EVENT = "dbx-tools:cancel-transcript-kinetic-scroll";

const isIOSWebKit = () => {
  const userAgent = window.navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(userAgent) ||
    (userAgent.includes("Macintosh") && window.navigator.maxTouchPoints > 1)
  );
};

const isKeyboardVisible = (viewport: VisualViewport | null): boolean =>
  Boolean(viewport && window.innerHeight - viewport.height > KEYBOARD_GEOMETRY_THRESHOLD_PX);

const composerInputFromEvent = (event: Event): HTMLTextAreaElement | null => {
  const target = event.target instanceof Element ? event.target : null;
  return target?.closest<HTMLTextAreaElement>(COMPOSER_INPUT_SELECTOR) ?? null;
};

const createTranscriptScroller = (viewport: HTMLElement, content: HTMLElement) =>
  new ScrollBooster({
    viewport,
    content,
    direction: "vertical",
    pointerMode: "mouse",
    scrollMode: "native",
    bounce: false,
    textSelection: true,
    wheel: false,
    keyboard: false,
  });

const syncScrollIndicator = (
  transcript: HTMLElement,
  indicator: HTMLElement | null,
  visible: boolean,
) => {
  if (!indicator) return;

  const maxScrollTop = transcript.scrollHeight - transcript.clientHeight;
  indicator.hidden = !visible || maxScrollTop <= 0;
  if (indicator.hidden) return;

  // Safari paints native overlay scrollbars against stale pre-keyboard geometry. This thumb is
  // positioned inside the resized transcript so it always matches the visible scroll region.
  const proportionalHeight =
    (transcript.clientHeight / transcript.scrollHeight) * transcript.clientHeight;
  const height = Math.min(
    transcript.clientHeight,
    Math.max(MIN_SCROLL_INDICATOR_HEIGHT_PX, Math.round(proportionalHeight)),
  );
  const scrollTop = Math.min(maxScrollTop, Math.max(0, transcript.scrollTop));
  const top = Math.round((scrollTop / maxScrollTop) * (transcript.clientHeight - height));
  indicator.style.height = `${height}px`;
  indicator.style.transform = `translateY(${top}px)`;
};

/**
 * Contains Mobile Safari keyboard and touch behavior inside the chat frame.
 *
 * When the host shell follows `visualViewport`, this hook owns the remaining iOS-specific work:
 * suppressing Safari's input-reveal pan, routing keyboard-open transcript drags through
 * ScrollBooster, stopping existing momentum before composer actions, and drawing the keyboard-safe
 * scrollbar thumb.
 */
export const useComposerViewportLock = (frameRef: RefObject<HTMLElement | null>) => {
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const dock = frame?.querySelector<HTMLElement>(COMPOSER_DOCK_SELECTOR);
    const transcript = frame?.querySelector<HTMLElement>(TRANSCRIPT_SELECTOR);
    const transcriptContent = frame?.querySelector<HTMLElement>(TRANSCRIPT_CONTENT_SELECTOR);
    const scrollIndicator =
      frame?.querySelector<HTMLElement>(TRANSCRIPT_INDICATOR_SELECTOR) ?? null;
    if (!frame || !dock || !transcript || !transcriptContent) return;

    const iosWebKit = isIOSWebKit();
    let transcriptScroller = iosWebKit
      ? createTranscriptScroller(transcript, transcriptContent)
      : null;
    let transcriptScrollerRestartFrame: number | null = null;
    let transcriptTouchRoutingEnabled = false;
    let momentumRestoreFrame: number | null = null;
    let momentumScrollTop = 0;
    let momentumOverflowY: string | null = null;
    let lastTouchY: number | null = null;
    let focusRevealTimer: number | null = null;
    let guardedInput: HTMLTextAreaElement | null = null;
    let guardedOpacity = "";
    let guardViewportHeight = 0;
    let guardViewportTop = 0;

    const syncIndicator = () =>
      syncScrollIndicator(transcript, scrollIndicator, transcriptTouchRoutingEnabled);

    const syncKeyboardState = () => {
      const keyboardVisible = iosWebKit && isKeyboardVisible(window.visualViewport);
      transcript.toggleAttribute("data-keyboard-touch-scroller", keyboardVisible);

      if (keyboardVisible !== transcriptTouchRoutingEnabled) {
        transcriptTouchRoutingEnabled = keyboardVisible;
        transcriptScroller?.updateOptions({ pointerMode: keyboardVisible ? "touch" : "mouse" });
      }
      syncIndicator();
    };

    const revealGuardedInput = () => {
      if (!guardedInput) return;
      guardedInput.style.opacity = guardedOpacity;
      delete guardedInput.dataset.iosFocusGuard;
      guardedInput = null;
      focusRevealTimer = null;
      guardViewportHeight = 0;
      guardViewportTop = 0;
    };

    const scheduleGuardReveal = (delay: number) => {
      if (focusRevealTimer !== null) window.clearTimeout(focusRevealTimer);
      focusRevealTimer = window.setTimeout(revealGuardedInput, delay);
    };

    const guardInput = (input: HTMLTextAreaElement) => {
      if (guardedInput === input) return;
      if (focusRevealTimer !== null) window.clearTimeout(focusRevealTimer);
      revealGuardedInput();
      guardedInput = input;
      guardedOpacity = input.style.opacity;
      guardViewportHeight = window.visualViewport?.height ?? window.innerHeight;
      guardViewportTop = window.visualViewport?.offsetTop ?? 0;
      input.dataset.iosFocusGuard = "true";
      input.style.opacity = "0";
    };

    const stopNativeTranscriptMomentum = () => {
      if (!iosWebKit) return;

      transcriptScroller?.setPosition({ y: transcript.scrollTop });
      momentumScrollTop = transcript.scrollTop;
      if (momentumOverflowY === null) momentumOverflowY = transcript.style.overflowY;
      if (momentumRestoreFrame !== null) window.cancelAnimationFrame(momentumRestoreFrame);

      // WebKit carries an existing inertial transcript gesture through keyboard focus. Removing
      // overflow for one frame ends that gesture while preserving the reader's exact position.
      transcript.style.overflowY = "hidden";
      transcript.scrollTop = momentumScrollTop;
      momentumRestoreFrame = window.requestAnimationFrame(() => {
        transcript.style.overflowY = momentumOverflowY ?? "";
        transcript.scrollTop = momentumScrollTop;
        momentumOverflowY = null;
        momentumRestoreFrame = null;
      });
    };

    const restartTranscriptScroller = () => {
      if (!iosWebKit) return;
      transcriptScroller?.destroy();
      transcriptScroller = null;
      if (transcriptScrollerRestartFrame !== null) {
        window.cancelAnimationFrame(transcriptScrollerRestartFrame);
      }

      // Reattach after the current touch sequence and its next paint have completed. Recreating the
      // instance during the same dispatch allows ScrollBooster's old kinetic loop to keep running.
      transcriptScrollerRestartFrame = window.requestAnimationFrame(() => {
        transcriptScrollerRestartFrame = window.requestAnimationFrame(() => {
          transcriptScroller = createTranscriptScroller(transcript, transcriptContent);
          transcriptScroller.updateOptions({
            pointerMode: transcriptTouchRoutingEnabled ? "touch" : "mouse",
          });
          transcriptScrollerRestartFrame = null;
        });
      });
    };

    const handleInputFocus = (event: FocusEvent) => {
      if (!iosWebKit) return;
      const input = event.target instanceof HTMLTextAreaElement ? event.target : null;
      if (!input?.matches(COMPOSER_INPUT_SELECTOR)) return;
      guardInput(input);
      scheduleGuardReveal(FOCUS_GUARD_FALLBACK_MS);
    };

    const handleInputBlur = (event: FocusEvent) => {
      if (event.target === guardedInput) revealGuardedInput();
    };

    const handleVisualViewportChange = () => {
      syncKeyboardState();
      const viewport = window.visualViewport;
      if (!guardedInput || !viewport) return;
      const heightChanged = guardViewportHeight - viewport.height > KEYBOARD_GEOMETRY_THRESHOLD_PX;
      const topChanged =
        Math.abs(viewport.offsetTop - guardViewportTop) > KEYBOARD_GEOMETRY_THRESHOLD_PX;
      if (!heightChanged && !topChanged) return;

      // Restore only after WebKit has started the keyboard transition and the host shell has
      // resized. Restoring earlier makes the visible textarea eligible for another reveal pan.
      scheduleGuardReveal(FOCUS_GUARD_SETTLE_MS);
    };

    const handleTouchStart = (event: TouchEvent) => {
      const input = composerInputFromEvent(event);
      if (input && iosWebKit) {
        // This must run before the native focus default action. Focus events can arrive after Safari
        // has already selected and centered its reveal target.
        guardInput(input);
        scheduleGuardReveal(FOCUS_GUARD_FALLBACK_MS);
      }
      lastTouchY = event.touches[0]?.clientY ?? null;
      stopNativeTranscriptMomentum();
    };

    const handleTouchMove = (event: TouchEvent) => {
      const touchY = event.touches[0]?.clientY;
      if (touchY === undefined) return;

      const input = composerInputFromEvent(event);
      const deltaY = lastTouchY === null ? 0 : touchY - lastTouchY;
      lastTouchY = touchY;

      if (input && input.scrollHeight > input.clientHeight + SCROLL_BOUNDARY_EPSILON_PX) {
        const canScrollTowardStart = deltaY > 0 && input.scrollTop > SCROLL_BOUNDARY_EPSILON_PX;
        const canScrollTowardEnd =
          deltaY < 0 &&
          input.scrollTop + input.clientHeight < input.scrollHeight - SCROLL_BOUNDARY_EPSILON_PX;
        if (canScrollTowardStart || canScrollTowardEnd) return;
      }

      // Composer drags must not select the document or visual viewport as the gesture scroller.
      if (event.cancelable) event.preventDefault();
    };

    const handleTouchEnd = () => {
      lastTouchY = null;
    };

    const resizeObserver =
      iosWebKit && scrollIndicator && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(syncIndicator)
        : null;
    resizeObserver?.observe(transcript);
    resizeObserver?.observe(transcriptContent);

    dock.addEventListener("touchstart", handleTouchStart, { passive: true });
    dock.addEventListener("touchmove", handleTouchMove, { passive: false });
    dock.addEventListener("touchend", handleTouchEnd, { passive: true });
    dock.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    dock.addEventListener("focus", handleInputFocus, true);
    dock.addEventListener("blur", handleInputBlur, true);
    transcript.addEventListener("scroll", syncIndicator, { passive: true });
    transcript.addEventListener(CANCEL_TRANSCRIPT_KINETIC_SCROLL_EVENT, restartTranscriptScroller);
    window.visualViewport?.addEventListener("resize", handleVisualViewportChange);
    window.visualViewport?.addEventListener("scroll", handleVisualViewportChange);
    window.visualViewport?.addEventListener("scrollend", handleVisualViewportChange);
    syncKeyboardState();

    return () => {
      if (momentumRestoreFrame !== null) window.cancelAnimationFrame(momentumRestoreFrame);
      if (focusRevealTimer !== null) window.clearTimeout(focusRevealTimer);
      if (transcriptScrollerRestartFrame !== null) {
        window.cancelAnimationFrame(transcriptScrollerRestartFrame);
      }
      revealGuardedInput();
      transcriptScroller?.destroy();
      resizeObserver?.disconnect();
      transcript.removeAttribute("data-keyboard-touch-scroller");
      if (scrollIndicator) scrollIndicator.hidden = true;
      if (momentumOverflowY !== null) transcript.style.overflowY = momentumOverflowY;
      dock.removeEventListener("touchstart", handleTouchStart);
      dock.removeEventListener("touchmove", handleTouchMove);
      dock.removeEventListener("touchend", handleTouchEnd);
      dock.removeEventListener("touchcancel", handleTouchEnd);
      dock.removeEventListener("focus", handleInputFocus, true);
      dock.removeEventListener("blur", handleInputBlur, true);
      transcript.removeEventListener("scroll", syncIndicator);
      transcript.removeEventListener(
        CANCEL_TRANSCRIPT_KINETIC_SCROLL_EVENT,
        restartTranscriptScroller,
      );
      window.visualViewport?.removeEventListener("resize", handleVisualViewportChange);
      window.visualViewport?.removeEventListener("scroll", handleVisualViewportChange);
      window.visualViewport?.removeEventListener("scrollend", handleVisualViewportChange);
    };
  }, [frameRef]);
};
