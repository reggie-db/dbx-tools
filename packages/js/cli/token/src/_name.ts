/** Validate and normalize a local service, secret, or certificate identity. */
export function safeName(value: string, label: string): string {
  const name = value.trim();
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new TypeError(`${label} name is invalid`);
  return name;
}
