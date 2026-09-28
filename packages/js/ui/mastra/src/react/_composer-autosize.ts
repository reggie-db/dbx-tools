/**
 * Reset and measure one composer textarea when its container has usable width.
 *
 * Resetting to `auto` before reading `scrollHeight` allows deleted content and
 * wider containers to shrink as well as letting multiline drafts grow.
 */
export function autosizeComposerTextarea(
  group: HTMLElement | null,
  textarea: HTMLTextAreaElement | null,
): void {
  if (!group || !textarea || group.getBoundingClientRect().width <= 0) return;
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

/**
 * Observe width changes without reacting to the group height that the textarea
 * itself controls. A zero-width observation resets the comparison sentinel so
 * reopening at the same prior width still triggers a fresh measurement.
 */
export function observeComposerWidth(
  group: HTMLElement,
  resize: () => void,
  Observer: typeof ResizeObserver | undefined = globalThis.ResizeObserver,
): () => void {
  if (!Observer) return () => {};
  let measuredWidth = 0;
  const observer = new Observer((entries) => {
    const width = entries[0]?.contentRect.width ?? group.getBoundingClientRect().width;
    if (!Number.isFinite(width)) return;
    if (width <= 0) {
      measuredWidth = 0;
      return;
    }
    if (width === measuredWidth) return;
    measuredWidth = width;
    resize();
  });
  observer.observe(group);
  return () => observer.disconnect();
}
