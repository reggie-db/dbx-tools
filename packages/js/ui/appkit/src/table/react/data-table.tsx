import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  cn,
} from "@databricks/appkit-ui/react";
import { toLabel } from "@dbx-tools/shared-core";
import {
  flexRender,
  functionalUpdate,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnOrderState,
  type ColumnSizingState,
  type OnChangeFn,
  type Row,
  type RowData,
  type SortingState,
  type Table,
  type TableOptions,
  type Updater,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsUpDownIcon,
  Columns3Icon,
  FilterIcon,
  GripVerticalIcon,
  RotateCcwIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  dataTableBrowserStorage,
  defaultDataTablePersistedFields,
  mergeDataTableColumnOrder,
  readDataTableState,
  writeDataTableState,
  type DataTablePersistence,
  type DataTableStateSnapshot,
} from "./data-table-state.ts";

/** A choice shown in a multi-select header filter. */
export interface DataTableFilterOption {
  label: ReactNode;
  value: string;
}

/** Header filter rendered for a column. */
export type DataTableHeaderFilter =
  | { type: "multi-select"; options: readonly DataTableFilterOption[] }
  | { type: "number" | "text"; placeholder?: string };

/** Optional metadata understood by {@link DataTable}. */
export interface DataTableColumnMeta {
  /** Accessible and menu label when the header is not plain text. */
  label?: ReactNode;
  /** Header filter configuration colocated with a static column definition. */
  headerFilter?: DataTableHeaderFilter | false;
  /** Hide this column from the visibility menu. */
  hideFromColumnMenu?: boolean;
}

/** Initial controlled or uncontrolled table state. */
export interface DataTableInitialState {
  columnFilters?: ColumnFiltersState;
  columnOrder?: ColumnOrderState;
  columnSizing?: ColumnSizingState;
  columnVisibility?: VisibilityState;
  sorting?: SortingState;
}

/** Props for the reusable AppKit data table. */
export interface DataTableProps<TData extends RowData> {
  /** Stable identifier used for accessibility and the default persistence key. */
  id: string;
  /** Row records. */
  data: TData[];
  /** TanStack column definitions. */
  columns: ColumnDef<TData, unknown>[];
  /** Initial table state, applied before persisted state. */
  initialState?: DataTableInitialState;
  /** Persist state in local storage by default, session storage when selected, or disable it. */
  persistence?: DataTablePersistence | false;
  /** Header filters keyed by column id. These override column metadata. */
  headerFilters?: Readonly<Record<string, DataTableHeaderFilter | false | undefined>>;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  columnFilters?: ColumnFiltersState;
  onColumnFiltersChange?: OnChangeFn<ColumnFiltersState>;
  columnOrder?: ColumnOrderState;
  onColumnOrderChange?: OnChangeFn<ColumnOrderState>;
  columnSizing?: ColumnSizingState;
  onColumnSizingChange?: OnChangeFn<ColumnSizingState>;
  columnVisibility?: VisibilityState;
  onColumnVisibilityChange?: OnChangeFn<VisibilityState>;
  /** Default behavior and sizes shared by columns. */
  defaultColumn?: Partial<ColumnDef<TData, unknown>>;
  /** Stable row id resolver. */
  getRowId?: TableOptions<TData>["getRowId"];
  /** Rendered toolbar summary. Defaults to the filtered row count. */
  summary?: ReactNode | ((table: Table<TData>) => ReactNode);
  /** Secondary toolbar state or provenance. */
  description?: ReactNode | ((table: Table<TData>) => ReactNode);
  /** Extra controls rendered before the standard column and reset controls. */
  toolbarActions?: ReactNode | ((table: Table<TData>) => ReactNode);
  ariaLabel?: string;
  empty?: ReactNode;
  loadingContent?: ReactNode;
  loading?: boolean;
  showColumnMenu?: boolean;
  showReset?: boolean;
  /** Called after the built-in table state reset, for related search or route state. */
  onReset?: () => void;
  enableColumnReordering?: boolean;
  enableColumnResizing?: boolean;
  /** Render rows in batches as the scroll sentinel approaches the viewport. */
  lazy?: boolean;
  /** Rows rendered before the first lazy-scroll expansion. */
  initialRowCount?: number;
  /** Rows added for each lazy-scroll expansion. */
  rowBatchSize?: number;
  resetScrollOnStateChange?: boolean;
  onRowClick?: (value: TData, row: Row<TData>) => void;
  isRowSelected?: (value: TData, row: Row<TData>) => boolean;
  getRowClassName?: (value: TData, row: Row<TData>) => string | undefined;
  getColumnLabel?: (column: Column<TData, unknown>) => ReactNode;
  className?: string;
  style?: CSSProperties;
}

interface ColumnDropTarget {
  id: string;
  position: "after" | "before";
}

const interactiveSelector =
  "a, button, input, select, textarea, [role='button'], [contenteditable='true']";

function columnDefinitionIds<TData extends RowData>(
  columns: ColumnDef<TData, unknown>[],
): string[] {
  return columns.flatMap((definition) => {
    if ("columns" in definition && Array.isArray(definition.columns)) {
      return columnDefinitionIds(definition.columns as ColumnDef<TData, unknown>[]);
    }
    if ("id" in definition && typeof definition.id === "string") return [definition.id];
    if ("accessorKey" in definition && typeof definition.accessorKey === "string") {
      return [definition.accessorKey];
    }
    return [];
  });
}

function useManagedTableState<T>(
  controlled: T | undefined,
  initial: T,
  onChange: OnChangeFn<T> | undefined,
): readonly [T, OnChangeFn<T>] {
  const [uncontrolled, setUncontrolled] = useState(initial);
  const current = controlled ?? uncontrolled;
  const currentRef = useRef(current);
  currentRef.current = current;
  const update = useCallback(
    (updater: Updater<T>) => {
      const next = functionalUpdate(updater, currentRef.current);
      currentRef.current = next;
      if (controlled === undefined) setUncontrolled(next);
      onChange?.(next);
    },
    [controlled, onChange],
  );
  return [current, update] as const;
}

function columnMeta<TData extends RowData>(column: Column<TData, unknown>): DataTableColumnMeta {
  return (column.columnDef.meta ?? {}) as DataTableColumnMeta;
}

function defaultColumnLabel<TData extends RowData>(column: Column<TData, unknown>): ReactNode {
  const metaLabel = columnMeta(column).label;
  if (metaLabel !== undefined) return metaLabel;
  return typeof column.columnDef.header === "string" ? column.columnDef.header : toLabel(column.id);
}

function labelText(label: ReactNode, fallback: string): string {
  return typeof label === "string" || typeof label === "number" ? String(label) : fallback;
}

function renderToolbarValue<TData extends RowData>(
  value: ReactNode | ((table: Table<TData>) => ReactNode) | undefined,
  table: Table<TData>,
): ReactNode {
  return typeof value === "function" ? value(table) : value;
}

function HeaderFilter<TData extends RowData>({
  column,
  filter,
  label,
}: {
  column: Column<TData, unknown>;
  filter: DataTableHeaderFilter;
  label: ReactNode;
}) {
  if (!column.getCanFilter()) return null;
  const current = column.getFilterValue();
  const selected = Array.isArray(current) ? current.map(String) : [];
  const textLabel = labelText(label, column.id);
  const placeholder =
    filter.type === "multi-select"
      ? undefined
      : (filter.placeholder ?? `Filter ${textLabel.toLocaleLowerCase()}`);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "dbx-data-table__filter-trigger",
            column.getIsFiltered() && "dbx-data-table__filter-trigger--active",
          )}
          aria-label={`Filter ${textLabel}`}
          title={`Filter ${textLabel}`}
        >
          <FilterIcon aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="dbx-data-table__filter-menu"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuLabel>Filter {label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {filter.type === "multi-select" ? (
          <div className="dbx-data-table__filter-options">
            {filter.options.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={selected.includes(option.value)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) => {
                  const next = checked
                    ? [...selected, option.value]
                    : selected.filter((value) => value !== option.value);
                  column.setFilterValue(next.length ? next : undefined);
                }}
              >
                {option.label}
              </DropdownMenuCheckboxItem>
            ))}
          </div>
        ) : (
          <div
            className="dbx-data-table__filter-control"
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Input
              autoFocus
              inputMode={filter.type === "number" ? "decimal" : "search"}
              min={filter.type === "number" ? 0 : undefined}
              type={filter.type === "number" ? "number" : "search"}
              value={String(current ?? "")}
              onChange={(event) => column.setFilterValue(event.target.value || undefined)}
              placeholder={placeholder}
              aria-label={placeholder}
            />
          </div>
        )}
        <div className="dbx-data-table__filter-footer">
          <Button
            variant="ghost"
            size="sm"
            disabled={!column.getIsFiltered()}
            onClick={() => column.setFilterValue(undefined)}
          >
            Clear
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * AppKit data table with persisted preferences, lazy row batching,
 * sortable and filterable headers, column visibility, reordering, and resizing.
 */
export function DataTable<TData extends RowData>({
  id,
  data,
  columns,
  initialState: requestedInitialState = {},
  persistence = {},
  headerFilters,
  sorting: controlledSorting,
  onSortingChange,
  columnFilters: controlledColumnFilters,
  onColumnFiltersChange,
  columnOrder: controlledColumnOrder,
  onColumnOrderChange,
  columnSizing: controlledColumnSizing,
  onColumnSizingChange,
  columnVisibility: controlledColumnVisibility,
  onColumnVisibilityChange,
  defaultColumn,
  getRowId,
  summary,
  description,
  toolbarActions,
  ariaLabel = "Data table",
  empty = "No matching rows.",
  loadingContent = "Loading rows.",
  loading = false,
  showColumnMenu = true,
  showReset = true,
  onReset,
  enableColumnReordering = true,
  enableColumnResizing = true,
  lazy = true,
  initialRowCount = 50,
  rowBatchSize = 50,
  resetScrollOnStateChange = true,
  onRowClick,
  isRowSelected,
  getRowClassName,
  getColumnLabel = defaultColumnLabel,
  className,
  style,
}: DataTableProps<TData>) {
  const availableColumnIds = useMemo(() => columnDefinitionIds(columns), [columns]);
  const persistenceKey =
    persistence === false ? undefined : (persistence.key ?? `dbx-tools.data-table.${id}.v1`);
  const persistenceStorage = persistence === false ? undefined : (persistence.storage ?? "local");
  const persistenceFields =
    persistence === false ? [] : (persistence.include ?? defaultDataTablePersistedFields);
  const [resolvedInitialState] = useState<DataTableStateSnapshot>(() => {
    const saved = persistenceKey
      ? readDataTableState(dataTableBrowserStorage(persistenceStorage ?? "local"), persistenceKey)
      : {};
    return {
      sorting: saved.sorting ?? requestedInitialState.sorting ?? [],
      columnFilters: saved.columnFilters ?? requestedInitialState.columnFilters ?? [],
      columnOrder: mergeDataTableColumnOrder(
        saved.columnOrder ?? requestedInitialState.columnOrder ?? availableColumnIds,
        availableColumnIds,
      ),
      columnSizing: { ...requestedInitialState.columnSizing, ...saved.columnSizing },
      columnVisibility: { ...requestedInitialState.columnVisibility, ...saved.columnVisibility },
    };
  });
  const [sorting, setSorting] = useManagedTableState(
    controlledSorting,
    resolvedInitialState.sorting,
    onSortingChange,
  );
  const [columnFilters, setColumnFilters] = useManagedTableState(
    controlledColumnFilters,
    resolvedInitialState.columnFilters,
    onColumnFiltersChange,
  );
  const [columnOrder, setColumnOrder] = useManagedTableState(
    controlledColumnOrder,
    resolvedInitialState.columnOrder,
    onColumnOrderChange,
  );
  const [columnSizing, setColumnSizing] = useManagedTableState(
    controlledColumnSizing,
    resolvedInitialState.columnSizing,
    onColumnSizingChange,
  );
  const [columnVisibility, setColumnVisibility] = useManagedTableState(
    controlledColumnVisibility,
    resolvedInitialState.columnVisibility,
    onColumnVisibilityChange,
  );
  const [draggedColumnId, setDraggedColumnId] = useState<string | null>(null);
  const [columnDropTarget, setColumnDropTarget] = useState<ColumnDropTarget | null>(null);
  const [visibleRowCount, setVisibleRowCount] = useState(initialRowCount);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const next = mergeDataTableColumnOrder(columnOrder, availableColumnIds);
    if (
      next.length === columnOrder.length &&
      next.every((value, index) => value === columnOrder[index])
    ) {
      return;
    }
    setColumnOrder(next);
  }, [availableColumnIds, columnOrder, setColumnOrder]);

  useEffect(() => {
    if (!persistenceKey) return;
    writeDataTableState(
      dataTableBrowserStorage(persistenceStorage ?? "local"),
      persistenceKey,
      { sorting, columnFilters, columnOrder, columnSizing, columnVisibility },
      persistenceFields,
    );
  }, [
    columnFilters,
    columnOrder,
    columnSizing,
    columnVisibility,
    persistenceFields,
    persistenceKey,
    persistenceStorage,
    sorting,
  ]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, columnOrder, columnSizing, columnVisibility },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnOrderChange: setColumnOrder,
    onColumnSizingChange: setColumnSizing,
    onColumnVisibilityChange: setColumnVisibility,
    columnResizeMode: "onChange",
    enableColumnResizing,
    defaultColumn: { minSize: 80, size: 150, maxSize: 560, ...defaultColumn },
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });
  const rows = table.getRowModel().rows;
  useEffect(() => {
    setVisibleRowCount(initialRowCount);
    if (resetScrollOnStateChange) scrollRef.current?.scrollTo({ top: 0 });
  }, [columnFilters, initialRowCount, resetScrollOnStateChange, rows.length, sorting]);
  useEffect(() => {
    if (!lazy || visibleRowCount >= rows.length) return;
    const root = scrollRef.current;
    const sentinel = loadMoreRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === "undefined") {
      setVisibleRowCount(rows.length);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleRowCount((current) => Math.min(rows.length, current + rowBatchSize));
        }
      },
      { root, rootMargin: "400px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [lazy, rowBatchSize, rows.length, visibleRowCount]);

  const reorderColumn = useCallback(
    (sourceId: string, targetId: string, position: ColumnDropTarget["position"]) => {
      if (sourceId === targetId) return;
      setColumnOrder((current) => {
        const next = mergeDataTableColumnOrder(current, availableColumnIds);
        const sourceIndex = next.indexOf(sourceId);
        const targetIndex = next.indexOf(targetId);
        if (sourceIndex < 0 || targetIndex < 0) return current;
        const [source] = next.splice(sourceIndex, 1);
        if (!source) return current;
        const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
        next.splice(adjustedTargetIndex + (position === "after" ? 1 : 0), 0, source);
        return next;
      });
    },
    [availableColumnIds, setColumnOrder],
  );
  const moveVisibleColumn = useCallback(
    (columnId: string, offset: -1 | 1) => {
      const ids = table.getVisibleLeafColumns().map((column) => column.id);
      const target = ids[ids.indexOf(columnId) + offset];
      if (target) reorderColumn(columnId, target, offset === -1 ? "before" : "after");
    },
    [reorderColumn, table],
  );
  const startColumnDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, sourceId: string) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      let target: ColumnDropTarget | null = null;
      event.currentTarget.focus();
      const clear = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        setDraggedColumnId(null);
        setColumnDropTarget(null);
      };
      const move = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        if (
          !active &&
          Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 4
        ) {
          return;
        }
        active = true;
        pointerEvent.preventDefault();
        setDraggedColumnId(sourceId);
        const header = document
          .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
          ?.closest<HTMLElement>("[role='columnheader'][data-column-id]");
        const targetId = header?.dataset.columnId;
        if (!header || !targetId || targetId === sourceId) {
          target = null;
          setColumnDropTarget(null);
          return;
        }
        const bounds = header.getBoundingClientRect();
        target = {
          id: targetId,
          position: pointerEvent.clientX < bounds.left + bounds.width / 2 ? "before" : "after",
        };
        setColumnDropTarget(target);
      };
      const finish = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        if (active && target) reorderColumn(sourceId, target.id, target.position);
        clear();
      };
      const cancel = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId === pointerId) clear();
      };
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
    },
    [reorderColumn],
  );

  const reset = useCallback(() => {
    if (persistenceKey) {
      try {
        dataTableBrowserStorage(persistenceStorage ?? "local")?.removeItem(persistenceKey);
      } catch {
        // Reset the live table even if storage is unavailable.
      }
    }
    setSorting(requestedInitialState.sorting ?? []);
    setColumnFilters(requestedInitialState.columnFilters ?? []);
    setColumnOrder(
      mergeDataTableColumnOrder(
        requestedInitialState.columnOrder ?? availableColumnIds,
        availableColumnIds,
      ),
    );
    setColumnSizing(requestedInitialState.columnSizing ?? {});
    setColumnVisibility(requestedInitialState.columnVisibility ?? {});
    onReset?.();
  }, [
    availableColumnIds,
    persistenceKey,
    persistenceStorage,
    onReset,
    requestedInitialState,
    setColumnFilters,
    setColumnOrder,
    setColumnSizing,
    setColumnVisibility,
    setSorting,
  ]);

  const menuColumns = useMemo(() => {
    const index = new Map(columnOrder.map((columnId, position) => [columnId, position]));
    return table
      .getAllLeafColumns()
      .filter((column) => !columnMeta(column).hideFromColumnMenu)
      .sort(
        (left, right) =>
          (index.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (index.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      );
  }, [columnOrder, table]);
  const visibleRows = lazy ? rows.slice(0, visibleRowCount) : rows;
  const tableWidth = `max(100%, ${table.getTotalSize()}px)`;
  const filteredCount = table.getFilteredRowModel().rows.length;
  const summaryContent =
    renderToolbarValue(summary, table) ??
    `${filteredCount} ${filteredCount === 1 ? "row" : "rows"}`;
  const descriptionContent = renderToolbarValue(description, table);

  const renderRow = (row: Row<TData>) => {
    const selected = isRowSelected?.(row.original, row) ?? false;
    return (
      <div
        key={row.id}
        data-selected={selected || undefined}
        className={cn(
          "dbx-data-table__row",
          onRowClick && "dbx-data-table__row--interactive",
          getRowClassName?.(row.original, row),
        )}
        role="row"
        tabIndex={onRowClick ? 0 : undefined}
        aria-selected={isRowSelected ? selected : undefined}
        onClick={
          onRowClick
            ? (event) => {
                if (event.target instanceof Element && event.target.closest(interactiveSelector)) {
                  return;
                }
                onRowClick(row.original, row);
              }
            : undefined
        }
        onKeyDown={
          onRowClick
            ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                if (
                  event.target instanceof Element &&
                  event.target.closest(interactiveSelector) !== event.currentTarget
                ) {
                  return;
                }
                event.preventDefault();
                onRowClick(row.original, row);
              }
            : undefined
        }
      >
        {row.getVisibleCells().map((cell) => (
          <div
            className="dbx-data-table__cell"
            data-column-id={cell.column.id}
            key={cell.id}
            role="cell"
            style={{ flexBasis: cell.column.getSize(), width: cell.column.getSize() }}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </div>
        ))}
      </div>
    );
  };

  return (
    <section
      id={id}
      className={cn("dbx-data-table", className)}
      style={{ height: "100%", ...style }}
      aria-label={ariaLabel}
      aria-busy={loading}
      aria-live="polite"
    >
      <div className="dbx-data-table__toolbar">
        <div className="dbx-data-table__summary">
          <strong>{summaryContent}</strong>
          {descriptionContent === undefined || descriptionContent === null ? null : (
            <span>{descriptionContent}</span>
          )}
        </div>
        <div className="dbx-data-table__actions">
          {renderToolbarValue(toolbarActions, table)}
          {showColumnMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Columns3Icon aria-hidden="true" /> Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="dbx-data-table__column-menu">
                <DropdownMenuLabel>Columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {menuColumns.map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    disabled={!column.getCanHide()}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) => column.toggleVisibility(Boolean(checked))}
                  >
                    {getColumnLabel(column)}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {showReset ? (
            <Button variant="ghost" size="sm" onClick={reset}>
              <RotateCcwIcon aria-hidden="true" /> Reset
            </Button>
          ) : null}
        </div>
      </div>
      <div className="dbx-data-table__viewport" ref={scrollRef}>
        <div
          className="dbx-data-table__table"
          role="table"
          aria-rowcount={rows.length}
          style={{ width: tableWidth }}
        >
          <div className="dbx-data-table__header" role="rowgroup">
            {table.getHeaderGroups().map((group) => (
              <div className="dbx-data-table__header-row" role="row" key={group.id}>
                {group.headers.map((header) => {
                  const column = header.column;
                  const sorted = column.getIsSorted();
                  const label = getColumnLabel(column);
                  const text = labelText(label, column.id);
                  const filter = headerFilters?.[column.id] ?? columnMeta(column).headerFilter;
                  return (
                    <div
                      className="dbx-data-table__header-cell"
                      data-column-id={column.id}
                      data-dragging={draggedColumnId === column.id || undefined}
                      data-drop-position={
                        columnDropTarget?.id === column.id ? columnDropTarget.position : undefined
                      }
                      key={header.id}
                      role="columnheader"
                      aria-sort={
                        sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                      }
                      style={{ flexBasis: header.getSize(), width: header.getSize() }}
                    >
                      {header.isPlaceholder ? null : (
                        <div className="dbx-data-table__header-control">
                          {enableColumnReordering ? (
                            <button
                              type="button"
                              className="dbx-data-table__drag-handle"
                              aria-label={`Reorder ${text} column. Drag or use Left and Right Arrow keys.`}
                              title="Drag to reorder; use Left and Right Arrow keys"
                              onPointerDown={(event) => startColumnDrag(event, column.id)}
                              onKeyDown={(event) => {
                                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                                event.preventDefault();
                                moveVisibleColumn(column.id, event.key === "ArrowLeft" ? -1 : 1);
                              }}
                            >
                              <GripVerticalIcon aria-hidden="true" />
                            </button>
                          ) : null}
                          {column.getCanSort() ? (
                            <button
                              type="button"
                              className="dbx-data-table__sort"
                              onClick={column.getToggleSortingHandler()}
                            >
                              {flexRender(column.columnDef.header, header.getContext())}
                              {sorted === "asc" ? (
                                <ArrowUpIcon aria-hidden="true" />
                              ) : sorted === "desc" ? (
                                <ArrowDownIcon aria-hidden="true" />
                              ) : (
                                <ChevronsUpDownIcon
                                  aria-hidden="true"
                                  className="dbx-data-table__sort-idle"
                                />
                              )}
                            </button>
                          ) : (
                            <span className="dbx-data-table__header-label">
                              {flexRender(column.columnDef.header, header.getContext())}
                            </span>
                          )}
                          {filter ? (
                            <HeaderFilter column={column} filter={filter} label={label} />
                          ) : null}
                        </div>
                      )}
                      {enableColumnResizing && header.column.getCanResize() ? (
                        <button
                          type="button"
                          className={cn(
                            "dbx-data-table__resizer",
                            header.column.getIsResizing() && "dbx-data-table__resizer--active",
                          )}
                          aria-label={`Resize ${text}; double-click to reset width`}
                          title="Drag to resize; double-click to reset width"
                          onClick={(event) => event.stopPropagation()}
                          onDoubleClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            header.column.resetSize();
                          }}
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="dbx-data-table__body" role="rowgroup">
            {visibleRows.map((row) => renderRow(row))}
            {visibleRows.length < rows.length ? (
              <div className="dbx-data-table__sentinel" ref={loadMoreRef} aria-hidden="true" />
            ) : null}
            {rows.length === 0 ? (
              <div className="dbx-data-table__empty" role="status">
                {loading ? loadingContent : empty}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export type {
  ColumnDef,
  ColumnFiltersState,
  ColumnOrderState,
  ColumnSizingState,
  OnChangeFn,
  SortingState,
  VisibilityState,
};
