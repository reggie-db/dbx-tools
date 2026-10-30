import { useLayoutEffect, type RefObject } from "react";

const COMPOSER_INPUT_SELECTOR = ".aui-composer-input";
const VISUAL_VIEWPORT_EVENTS = ["resize", "scroll", "scrollend"] as const;
const KEYBOARD_INSET_THRESHOLD_PX = 80;
const KEYBOARD_CLOSE_DURATION_MS = 460;
const KEYBOARD_CLOSE_FALLBACK_MS = 650;

const isKeyboardVisible = (viewport: VisualViewport | null): boolean =>
  Boolean(viewport && window.innerHeight - viewport.height > KEYBOARD_INSET_THRESHOLD_PX);

const isTouchComposerFocused = (): boolean =>
  navigator.maxTouchPoints > 0 && document.activeElement?.matches(COMPOSER_INPUT_SELECTOR) === true;

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
    let keyboardCloseTimer = 0;

    const clearKeyboardClosingState = () => {
      window.clearTimeout(keyboardCloseTimer);
      keyboardCloseTimer = 0;
      delete frame.dataset.keyboardClosing;
    };

    const commit = () => {
      const top = viewport?.pageTop ?? window.scrollY;
      const left = viewport?.pageLeft ?? window.scrollX;
      const width = viewport?.width ?? window.innerWidth;
      const measuredHeight = viewport?.height ?? window.innerHeight;
      const keyboardVisible =
        isTouchComposerFocused() ||
        window.innerHeight - measuredHeight > KEYBOARD_INSET_THRESHOLD_PX;
      const viewportRestored = !keyboardVisible;
      if (keyboardVisible) {
        frame.dataset.keyboardOpen = "true";
      } else {
        delete frame.dataset.keyboardOpen;
      }
      if (frame.dataset.keyboardClosing === "true" && viewportRestored) {
        clearKeyboardClosingState();
      }

      frame.style.setProperty("--demo-viewport-top", `${top}px`);
      frame.style.setProperty("--demo-viewport-left", `${left}px`);
      frame.style.setProperty("--demo-viewport-width", `${width}px`);
      frame.style.setProperty("--demo-viewport-height", `${measuredHeight}px`);
    };

    const handleFocusOut = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.matches(COMPOSER_INPUT_SELECTOR) || !isKeyboardVisible(viewport)) {
        commit();
        return;
      }

      frame.dataset.keyboardClosing = "true";
      frame.style.setProperty("--demo-keyboard-close-duration", `${KEYBOARD_CLOSE_DURATION_MS}ms`);
      // Activate the transition before moving the shell to the restored layout height.
      void frame.offsetHeight;
      frame.style.setProperty("--demo-viewport-height", `${window.innerHeight}px`);
      window.clearTimeout(keyboardCloseTimer);
      keyboardCloseTimer = window.setTimeout(clearKeyboardClosingState, KEYBOARD_CLOSE_FALLBACK_MS);
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (navigator.maxTouchPoints > 0 && target?.matches(COMPOSER_INPUT_SELECTOR)) {
        frame.dataset.keyboardOpen = "true";
      }
      commit();
    };

    for (const eventName of VISUAL_VIEWPORT_EVENTS) {
      viewport?.addEventListener(eventName, commit);
    }
    window.addEventListener("resize", commit);
    window.addEventListener("scroll", commit, { passive: true });
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    commit();

    return () => {
      for (const eventName of VISUAL_VIEWPORT_EVENTS) {
        viewport?.removeEventListener(eventName, commit);
      }
      clearKeyboardClosingState();
      window.removeEventListener("resize", commit);
      window.removeEventListener("scroll", commit);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, [frameRef]);
};
