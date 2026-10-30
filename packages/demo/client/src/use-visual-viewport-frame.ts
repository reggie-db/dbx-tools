import { useLayoutEffect, type RefObject } from "react";

const KEYBOARD_INSET_THRESHOLD = 80;
const KEYBOARD_CLOSE_FALLBACK_MS = 700;

/** Keep the application shell aligned with Mobile Safari's visual viewport. */
export const useVisualViewportFrame = (frameRef: RefObject<HTMLElement | null>) => {
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const viewport = window.visualViewport;
    let keyboardClosing = false;
    let keyboardCloseTimer = 0;

    const commit = () => {
      const top = viewport?.pageTop ?? window.scrollY;
      const left = viewport?.pageLeft ?? window.scrollX;
      const width = viewport?.width ?? window.innerWidth;
      const measuredHeight = viewport?.height ?? window.innerHeight;
      const viewportRestored = window.innerHeight - measuredHeight <= KEYBOARD_INSET_THRESHOLD;
      if (keyboardClosing && viewportRestored) {
        keyboardClosing = false;
        window.clearTimeout(keyboardCloseTimer);
        delete frame.dataset.keyboardClosing;
      }
      const height = keyboardClosing
        ? Math.max(measuredHeight, window.innerHeight)
        : measuredHeight;

      frame.style.setProperty("--demo-viewport-top", `${top}px`);
      frame.style.setProperty("--demo-viewport-left", `${left}px`);
      frame.style.setProperty("--demo-viewport-width", `${width}px`);
      frame.style.setProperty("--demo-viewport-height", `${height}px`);
    };

    const handleFocusOut = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const composerBlurred = target?.classList.contains("aui-composer-input") ?? false;
      const keyboardVisible =
        viewport !== null &&
        viewport !== undefined &&
        window.innerHeight - viewport.height > KEYBOARD_INSET_THRESHOLD;
      if (!composerBlurred || !keyboardVisible) {
        commit();
        return;
      }

      keyboardClosing = true;
      frame.dataset.keyboardClosing = "true";
      window.clearTimeout(keyboardCloseTimer);
      keyboardCloseTimer = window.setTimeout(() => {
        keyboardClosing = false;
        delete frame.dataset.keyboardClosing;
        commit();
      }, KEYBOARD_CLOSE_FALLBACK_MS);
      commit();
    };

    viewport?.addEventListener("resize", commit);
    viewport?.addEventListener("scroll", commit);
    viewport?.addEventListener("scrollend", commit);
    window.addEventListener("resize", commit);
    window.addEventListener("scroll", commit, { passive: true });
    document.addEventListener("focusin", commit);
    document.addEventListener("focusout", handleFocusOut);
    commit();

    return () => {
      viewport?.removeEventListener("resize", commit);
      viewport?.removeEventListener("scroll", commit);
      viewport?.removeEventListener("scrollend", commit);
      window.clearTimeout(keyboardCloseTimer);
      delete frame.dataset.keyboardClosing;
      window.removeEventListener("resize", commit);
      window.removeEventListener("scroll", commit);
      document.removeEventListener("focusin", commit);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, [frameRef]);
};
