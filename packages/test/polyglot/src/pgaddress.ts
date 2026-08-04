import { readFileSync } from "node:fs";

import { pgaddress, type ParsedAddress } from "@dbx-tools/appkit";

export type PgAddressOperation = "parseAddress" | "parseResourcePath";

export interface PgAddressCase {
  name: string;
  operation: PgAddressOperation;
  input: string | null;
  expected: ParsedAddress;
}

export interface PgAddressResult {
  name: string;
  result: ParsedAddress;
}

export function readPgAddressCases(path: string): PgAddressCase[] {
  return JSON.parse(readFileSync(path, "utf8")) as PgAddressCase[];
}

export function runTypeScriptPgAddressCases(cases: PgAddressCase[]): PgAddressResult[] {
  return cases.map(({ name, operation, input }) => ({
    name,
    result:
      operation === "parseAddress"
        ? pgaddress.parseAddress(input)
        : pgaddress.parseResourcePath(input),
  }));
}
