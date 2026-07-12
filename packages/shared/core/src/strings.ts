/** Upper-case the first character of `s`. */
export function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** A friendly greeting - reused across the demo packages. */
export function greet(name: string): string {
  return `Hello, ${capitalize(name)}!`;
}
