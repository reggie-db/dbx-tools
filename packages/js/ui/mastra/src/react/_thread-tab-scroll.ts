/** Calculate the scroll position that centers one tab in its scroll viewport. */
export const centeredThreadTabScrollLeft = ({
  currentScrollLeft,
  viewportWidth,
  scrollWidth,
  tabLeft,
  tabWidth,
}: {
  currentScrollLeft: number;
  viewportWidth: number;
  scrollWidth: number;
  /** Tab left edge relative to the visible viewport. */
  tabLeft: number;
  tabWidth: number;
}): number => {
  const centered = currentScrollLeft + tabLeft - (viewportWidth - tabWidth) / 2;
  return Math.min(Math.max(centered, 0), Math.max(scrollWidth - viewportWidth, 0));
};
