/** Sum two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

/** Clamp `n` into the inclusive `[min, max]` range. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
