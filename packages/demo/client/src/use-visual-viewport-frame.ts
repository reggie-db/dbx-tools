import { useLayoutEffect, type RefObject } from "react";

const COMPOSER_INPUT_SELECTOR = ".aui-composer-input";
const VISUAL_VIEWPORT_EVENTS = ["resize", "scroll", "scrollend"] as const;
const KEYBOARD_INSET_THRESHOLD_PX = 80;
const KEYBOARD_CLOSE_FALLBACK_MS = 700;

const isKeyboardVisible = (viewport: VisualViewport | null): boolean =>
  Boolean(viewport && window.innerHeight - viewport.height > KEYBOARD_INSET_THRESHOLD_PX);

/**
 * Synchronize the absolute application shell with Mobile Safari's visual viewport.
 *
 * Safari can pan the visual viewport without changing `window.scrollY`, especially while revealing
 * a focused textarea. Updating the shell synchronously from `pageTop`, `pageLeft`, `width`, and
 * `height` keeps the header, transcript, and composer in one coordinate system throughout the
 * keyboard animation.
 */
export const useVisualViewportFrame = (frameRef: RefObject<HTMLElement | null>) => {
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const viewport = window.visualViewport;
    let keyboardClosing = false;
    let keyboardCloseTimer = 0;

    const clearKeyboardClosingState = () => {
      keyboardClosing = false;
      window.clearTimeout(keyboardCloseTimer);
      delete frame.dataset.keyboardClosing;
    };

    const commit = () => {
      const top = viewport?.pageTop ?? window.scrollY;
      const left = viewport?.pageLeft ?? window.scrollX;
      const width = viewport?.width ?? window.innerWidth;
      const measuredHeight = viewport?.height ?? window.innerHeight;
      const viewportRestored = window.innerHeight - measuredHeight <= KEYBOARD_INSET_THRESHOLD_PX;
      if (keyboardClosing && viewportRestored) clearKeyboardClosingState();

      // WebKit can report intermediate keyboard-close heights after the textarea has blurred. Keep
      // the larger layout height during that short interval so the composer does not jump upward,
      // while CSS smooths the shell back to the restored viewport.
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
      if (!target?.matches(COMPOSER_INPUT_SELECTOR) || !isKeyboardVisible(viewport)) {
        commit();
        return;
      }

      keyboardClosing = true;
      frame.dataset.keyboardClosing = "true";
      window.clearTimeout(keyboardCloseTimer);
      keyboardCloseTimer = window.setTimeout(() => {
        clearKeyboardClosingState();
        commit();
      }, KEYBOARD_CLOSE_FALLBACK_MS);
      commit();
    };

    for (const eventName of VISUAL_VIEWPORT_EVENTS) {
      viewport?.addEventListener(eventName, commit);
    }
    window.addEventListener("resize", commit);
    window.addEventListener("scroll", commit, { passive: true });
    document.addEventListener("focusin", commit);
    document.addEventListener("focusout", handleFocusOut);
    commit();

    return () => {
      for (const eventName of VISUAL_VIEWPORT_EVENTS) {
        viewport?.removeEventListener(eventName, commit);
      }
      clearKeyboardClosingState();
      window.removeEventListener("resize", commit);
      window.removeEventListener("scroll", commit);
      document.removeEventListener("focusin", commit);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, [frameRef]);
};
