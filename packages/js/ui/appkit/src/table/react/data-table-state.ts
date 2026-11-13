import { isRecord } from "@dbx-tools/shared-core";
import type {
  ColumnFiltersState,
  ColumnOrderState,
  ColumnSizingState,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";

/** Browser storage used for persisted table state. */
export type DataTableStorage = "local" | "session";

/** Table state fields that can be persisted between visits. */
export type DataTablePersistedField =
  "columnFilters" | "columnOrder" | "columnSizing" | "columnVisibility" | "sorting";

/** Persisted, JSON-safe table state. */
export interface DataTableStateSnapshot {
  columnFilters: ColumnFiltersState;
  columnOrder: ColumnOrderState;
  columnSizing: ColumnSizingState;
  columnVisibility: VisibilityState;
  sorting: SortingState;
}

/** Browser persistence configuration. Local storage and all fields are the defaults. */
export interface DataTablePersistence {
  /** Override the generated `dbx-tools.data-table.<id>.v1` key. */
  key?: string;
  /** Select local or tab-scoped session storage. */
  storage?: DataTableStorage;
  /** Limit which state fields are saved. */
  include?: readonly DataTablePersistedField[];
}

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter extends StorageReader {
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

/** Default set of table fields saved between visits. */
export const defaultDataTablePersistedFields: readonly DataTablePersistedField[] = [
  "columnFilters",
  "columnOrder",
  "columnSizing",
  "columnVisibility",
  "sorting",
];

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function booleanRecord(value: unknown): VisibilityState | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    ),
  );
}

function numberRecord(value: unknown): ColumnSizingState | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0,
    ),
  );
}

function sortingState(value: unknown): SortingState | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "string" && typeof entry.desc === "boolean"
      ? [{ id: entry.id, desc: entry.desc }]
      : [],
  );
}

function filterState(value: unknown): ColumnFiltersState | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "string" && "value" in entry
      ? [{ id: entry.id, value: entry.value }]
      : [],
  );
}

/** Read and validate a persisted table snapshot. */
export function readDataTableState(
  storage: StorageReader | undefined,
  key: string,
): Partial<DataTableStateSnapshot> {
  if (!storage) return {};
  try {
    const serialized = storage.getItem(key);
    if (!serialized) return {};
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value)) return {};
    const columnFilters = filterState(value.columnFilters);
    const columnOrder = stringArray(value.columnOrder);
    const columnSizing = numberRecord(value.columnSizing);
    const columnVisibility = booleanRecord(value.columnVisibility);
    const sorting = sortingState(value.sorting);
    return {
      ...(columnFilters ? { columnFilters } : {}),
      ...(columnOrder ? { columnOrder } : {}),
      ...(columnSizing ? { columnSizing } : {}),
      ...(columnVisibility ? { columnVisibility } : {}),
      ...(sorting ? { sorting } : {}),
    };
  } catch {
    return {};
  }
}

/** Keep saved column order for known columns and append newly introduced columns. */
export function mergeDataTableColumnOrder(
  saved: ColumnOrderState,
  available: ColumnOrderState,
): ColumnOrderState {
  const known = saved.filter((id) => available.includes(id));
  return [...known, ...available.filter((id) => !known.includes(id))];
}

/** Write selected table fields without breaking interaction when storage is unavailable. */
export function writeDataTableState(
  storage: StorageWriter | undefined,
  key: string,
  value: DataTableStateSnapshot,
  include: readonly DataTablePersistedField[],
): void {
  if (!storage) return;
  try {
    storage.setItem(
      key,
      JSON.stringify(Object.fromEntries(include.map((field) => [field, value[field]]))),
    );
  } catch {
    // Table interaction stays available when browser storage is unavailable.
  }
}

/** Resolve browser storage without throwing in SSR or privacy-restricted contexts. */
export function dataTableBrowserStorage(kind: DataTableStorage): StorageWriter | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return undefined;
  }
}
