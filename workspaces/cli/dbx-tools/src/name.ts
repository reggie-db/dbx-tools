const PACKAGE_IDENTIFIER_REGEXP = /^\s*@?([^/\s]+)\s*(?:\/\s*(.*?))?\s*$/;

const NAME_PARTS_REGEXP = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|[^A-Za-z0-9._-]+/g;

const NAME_PARTS_EDGE_REGEXP = /^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g;

export type PackageIdentifier = InstanceType<typeof PackageIdentifierImpl>;

class PackageIdentifierImpl {
  public readonly scope?: string;

  constructor(
    scope: string | null | undefined,
    public readonly name: string,
  ) {
    this.scope = scope || undefined;
  }

  public get packageName(): string {
    return this.scope ? `@${this.scope}/${this.name}` : this.name;
  }

  public toString(): string {
    return this.packageName;
  }
}

function parsePackageIdentifier(value: string): PackageIdentifier | undefined {
  const match = value ? PACKAGE_IDENTIFIER_REGEXP.exec(value) : null;
  if (match) {
    const [, ...parts] = match;
    const [first, second] = parts
      .map((part) => toNameParts(part))
      .filter((parts) => parts.length)
      .map((parts) => parts.join("-"));
    if (second) {
      return new PackageIdentifierImpl(first, second);
    } else if (first) {
      return new PackageIdentifierImpl(undefined, first);
    }
  }
  return undefined;
}

export function toNameParts(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(NAME_PARTS_REGEXP)
    .map((part) => part.replace(NAME_PARTS_EDGE_REGEXP, "").toLowerCase())
    .filter(Boolean);
}

if (import.meta.main) {
  console.log(String(parsePackageIdentifier("cool")));
  console.log(String(parsePackageIdentifier("cool/dude")));
  console.log(String(parsePackageIdentifier("@myCoolDude/wowThisIsCrazy")));
}
