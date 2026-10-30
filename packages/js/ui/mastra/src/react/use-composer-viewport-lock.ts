import { ScrollBooster } from "scrollbooster";
import { useLayoutEffect, type RefObject } from "react";

const SCROLL_BOUNDARY_EPSILON = 1;
const KEYBOARD_TRANSITION_THRESHOLD = 80;
const FOCUS_GUARD_FALLBACK_MS = 600;
const FOCUS_GUARD_SETTLE_MS = 120;

export const CANCEL_TRANSCRIPT_KINETIC_SCROLL_EVENT = "dbx-tools:cancel-transcript-kinetic-scroll";

const isIOSWebKit = () => {
  const userAgent = window.navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(userAgent) ||
    (userAgent.includes("Macintosh") && window.navigator.maxTouchPoints > 1)
  );
};

/** Prevent Mobile Safari focus and touch gestures from panning the document. */
export const useComposerViewportLock = (frameRef: RefObject<HTMLElement | null>) => {
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const dock = frame?.querySelector<HTMLElement>('[data-slot="aui_composer-dock"]');
    const transcript = frame?.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    const transcriptContent = frame?.querySelector<HTMLElement>('[data-slot="aui_thread-content"]');
    if (!dock || !transcript || !transcriptContent) return;

    const createTranscriptScroller = () =>
      isIOSWebKit()
        ? new ScrollBooster({
            viewport: transcript,
            content: transcriptContent,
            direction: "vertical",
            pointerMode: "mouse",
            scrollMode: "native",
            bounce: false,
            textSelection: true,
            wheel: false,
            keyboard: false,
          })
        : null;
    let transcriptScroller = createTranscriptScroller();
    let transcriptScrollerRestartFrame: number | null = null;
    let transcriptTouchRoutingEnabled = false;
    let lastTouchY: number | null = null;
    let focusRevealTimer: number | null = null;
    let guardedInput: HTMLTextAreaElement | null = null;
    let guardedOpacity = "";
    let guardViewportHeight = 0;
    let guardViewportTop = 0;

    const syncTranscriptTouchRouting = () => {
      const viewport = window.visualViewport;
      const keyboardVisible =
        viewport !== null &&
        viewport !== undefined &&
        window.innerHeight - viewport.height > KEYBOARD_TRANSITION_THRESHOLD;
      if (!transcriptScroller) return;
      if (keyboardVisible === transcriptTouchRoutingEnabled) return;
      transcriptTouchRoutingEnabled = keyboardVisible;
      transcriptScroller.updateOptions({ pointerMode: keyboardVisible ? "touch" : "mouse" });
      transcript.toggleAttribute("data-keyboard-touch-scroller", keyboardVisible);
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

    const handleInputFocus = (event: FocusEvent) => {
      if (!isIOSWebKit()) return;
      const input = event.target instanceof HTMLTextAreaElement ? event.target : null;
      if (!input?.classList.contains("aui-composer-input")) return;
      guardInput(input);
      scheduleGuardReveal(FOCUS_GUARD_FALLBACK_MS);
    };

    const handleInputBlur = (event: FocusEvent) => {
      if (event.target === guardedInput) revealGuardedInput();
    };

    const handleVisualViewportChange = () => {
      syncTranscriptTouchRouting();
      const viewport = window.visualViewport;
      if (!guardedInput || !viewport) return;
      const heightChanged = guardViewportHeight - viewport.height > KEYBOARD_TRANSITION_THRESHOLD;
      const topChanged =
        Math.abs(viewport.offsetTop - guardViewportTop) > KEYBOARD_TRANSITION_THRESHOLD;
      if (!heightChanged && !topChanged) return;
      scheduleGuardReveal(FOCUS_GUARD_SETTLE_MS);
    };

    const handleTouchStart = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const input = target?.closest<HTMLTextAreaElement>(".aui-composer-input");
      if (input && isIOSWebKit()) {
        guardInput(input);
        scheduleGuardReveal(FOCUS_GUARD_FALLBACK_MS);
      }
      lastTouchY = event.touches[0]?.clientY ?? null;
    };

    const handleTouchMove = (event: TouchEvent) => {
      const touchY = event.touches[0]?.clientY;
      if (touchY === undefined) return;

      const target = event.target instanceof Element ? event.target : null;
      const input = target?.closest<HTMLTextAreaElement>(".aui-composer-input");
      const deltaY = lastTouchY === null ? 0 : touchY - lastTouchY;
      lastTouchY = touchY;

      if (input && input.scrollHeight > input.clientHeight + SCROLL_BOUNDARY_EPSILON) {
        const canScrollTowardStart = deltaY > 0 && input.scrollTop > SCROLL_BOUNDARY_EPSILON;
        const canScrollTowardEnd =
          deltaY < 0 &&
          input.scrollTop + input.clientHeight < input.scrollHeight - SCROLL_BOUNDARY_EPSILON;
        if (canScrollTowardStart || canScrollTowardEnd) return;
      }

      if (event.cancelable) event.preventDefault();
    };

    const handleTouchEnd = () => {
      lastTouchY = null;
    };

    const handleCancelTranscriptKineticScroll = () => {
      transcriptScroller?.destroy();
      transcriptScroller = null;
      if (transcriptScrollerRestartFrame !== null) {
        window.cancelAnimationFrame(transcriptScrollerRestartFrame);
      }
      transcriptScrollerRestartFrame = window.requestAnimationFrame(() => {
        transcriptScrollerRestartFrame = window.requestAnimationFrame(() => {
          transcriptScroller = createTranscriptScroller();
          transcriptScroller?.updateOptions({
            pointerMode: transcriptTouchRoutingEnabled ? "touch" : "mouse",
          });
          transcriptScrollerRestartFrame = null;
        });
      });
    };

    dock.addEventListener("touchstart", handleTouchStart, { passive: true });
    dock.addEventListener("touchmove", handleTouchMove, { passive: false });
    dock.addEventListener("touchend", handleTouchEnd, { passive: true });
    dock.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    dock.addEventListener("focus", handleInputFocus, true);
    dock.addEventListener("blur", handleInputBlur, true);
    transcript.addEventListener(
      CANCEL_TRANSCRIPT_KINETIC_SCROLL_EVENT,
      handleCancelTranscriptKineticScroll,
    );
    window.visualViewport?.addEventListener("resize", handleVisualViewportChange);
    window.visualViewport?.addEventListener("scroll", handleVisualViewportChange);
    window.visualViewport?.addEventListener("scrollend", handleVisualViewportChange);
    syncTranscriptTouchRouting();

    return () => {
      if (focusRevealTimer !== null) window.clearTimeout(focusRevealTimer);
      if (transcriptScrollerRestartFrame !== null) {
        window.cancelAnimationFrame(transcriptScrollerRestartFrame);
      }
      revealGuardedInput();
      transcriptScroller?.destroy();
      transcript.removeAttribute("data-keyboard-touch-scroller");
      dock.removeEventListener("touchstart", handleTouchStart);
      dock.removeEventListener("touchmove", handleTouchMove);
      dock.removeEventListener("touchend", handleTouchEnd);
      dock.removeEventListener("touchcancel", handleTouchEnd);
      dock.removeEventListener("focus", handleInputFocus, true);
      dock.removeEventListener("blur", handleInputBlur, true);
      transcript.removeEventListener(
        CANCEL_TRANSCRIPT_KINETIC_SCROLL_EVENT,
        handleCancelTranscriptKineticScroll,
      );
      window.visualViewport?.removeEventListener("resize", handleVisualViewportChange);
      window.visualViewport?.removeEventListener("scroll", handleVisualViewportChange);
      window.visualViewport?.removeEventListener("scrollend", handleVisualViewportChange);
    };
  }, [frameRef]);
};
