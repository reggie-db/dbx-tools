import { readFileSync } from "node:fs";

import { hash, object, string } from "@dbx-tools/shared-core";

interface ExpectedResult {
  result?: string;
  error?: string;
}

interface FnvHashCase {
  name: string;
  operation: "fnvHash";
  value: string;
  length?: number;
  expected: ExpectedResult;
}

interface StableKeyCase {
  name: string;
  operation: "toStableKey";
  value: unknown;
  expected: ExpectedResult;
}

interface IdentifierCase {
  name: string;
  operation: "toIdentifier";
  values: string[];
  expected: ExpectedResult;
}

export type CoreIdentityCase = FnvHashCase | StableKeyCase | IdentifierCase;

export interface CoreIdentityResult extends ExpectedResult {
  name: string;
}

export function readCoreIdentityCases(path: string): CoreIdentityCase[] {
  return JSON.parse(readFileSync(path, "utf8")) as CoreIdentityCase[];
}

export function runTypeScriptCoreIdentityCases(cases: CoreIdentityCase[]): CoreIdentityResult[] {
  return cases.map((testCase) => {
    try {
      let result: string;
      switch (testCase.operation) {
        case "fnvHash":
          result = hash.fnvHashWithOptions(
            testCase.length === undefined ? {} : { length: testCase.length },
            testCase.value,
          );
          break;
        case "toStableKey":
          result = object.toStableKey(decodeValue(testCase.value));
          break;
        case "toIdentifier":
          result = string.toIdentifier(...testCase.values);
          break;
      }
      return { name: testCase.name, result };
    } catch (cause) {
      return {
        name: testCase.name,
        error: cause instanceof Error ? cause.name : typeof cause,
      };
    }
  });
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value === null || typeof value !== "object") return value;

  const descriptor = value as { $type?: string; values?: unknown[] };
  switch (descriptor.$type) {
    case "negativeZero":
      return -0;
    case "set":
      return new Set((descriptor.values ?? []).map(decodeValue));
    case "cycle": {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      return cyclic;
    }
    case "nan":
      return Number.NaN;
    default:
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, decodeValue(item)]),
      );
  }
}
