import { useState, type ReactNode } from "react";
import {
  flexRender, getCoreRowModel, getPaginationRowModel, getSortedRowModel, useReactTable,
  type ColumnDef, type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";
import { formatNumber } from "../../lib/format";

/**
 * Thin TanStack Table wrapper: sortable headers (with aria-sort), optional pagination,
 * keyboard-activatable rows, and an empty state.
 */
export function DataTable<T>({ data, columns, getRowId, onRowClick, selectedId, pageSize = 25, dense, mono, empty, initialSort, label }: {
  data: T[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack column value types vary per column
  columns: ColumnDef<T, any>[];
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedId?: string | null;
  pageSize?: number | null;
  dense?: boolean;
  mono?: boolean;
  empty?: ReactNode;
  initialSort?: SortingState;
  label: string;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSort ?? []);
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    ...(pageSize ? { getPaginationRowModel: getPaginationRowModel(), initialState: { pagination: { pageSize, pageIndex: 0 } } } : {}),
  });

  const rows = table.getRowModel().rows;
  const { pageIndex, pageSize: size } = table.getState().pagination;
  const total = data.length;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className={cn("w-full border-collapse text-left", mono ? "font-mono text-[12.5px]" : "text-sm")} aria-label={label}>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border">
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  const canSort = h.column.getCanSort();
                  return (
                    <th
                      key={h.id}
                      scope="col"
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                      className={cn("whitespace-nowrap px-4 font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-faint", dense ? "py-2" : "py-3")}
                    >
                      {canSort ? (
                        <button type="button" onClick={h.column.getToggleSortingHandler()} className="focus-ring -mx-1 inline-flex items-center gap-1 rounded-xs px-1 hover:text-text">
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sorted === "asc" ? <ArrowUp size={12} aria-hidden /> : sorted === "desc" ? <ArrowDown size={12} aria-hidden /> : <ArrowUpDown size={12} className="opacity-40" aria-hidden />}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row) => {
              const selected = selectedId === row.id;
              return (
                <tr
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  onKeyDown={onRowClick ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onRowClick(row.original)) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-selected={onRowClick ? selected : undefined}
                  className={cn(
                    "border-b border-border/70 transition-colors last:border-0",
                    onRowClick && "focus-ring cursor-pointer hover:bg-bg-subtle",
                    selected && "bg-accent-soft hover:bg-accent-soft",
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className={cn("px-4 align-middle", dense ? "py-2" : "py-3")}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="p-6">{empty}</div>}
      </div>
      {pageSize && total > size && (
        <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-3 text-sm text-muted">
          <span className="tabular">
            {formatNumber(pageIndex * size + 1)}–{formatNumber(Math.min(total, (pageIndex + 1) * size))} of {formatNumber(total)}
          </span>
          <div className="flex gap-1">
            <button type="button" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} className="focus-ring grid size-8 place-items-center rounded-sm hover:bg-bg-subtle disabled:opacity-40" aria-label="Previous page">
              <ChevronLeft size={16} aria-hidden />
            </button>
            <button type="button" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} className="focus-ring grid size-8 place-items-center rounded-sm hover:bg-bg-subtle disabled:opacity-40" aria-label="Next page">
              <ChevronRight size={16} aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
