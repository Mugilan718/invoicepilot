"use client";

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import type {
  ColDef,
  GridApi,
  GridReadyEvent,
  IRowNode,
  RowClassRules,
  ValueFormatterParams,
} from "ag-grid-community";
import type { InvoiceWithAging } from "@/lib/types";
import { clientOf, PAID_STATUSES } from "@/lib/stats";
import { compareIsoDate, getNarrow, getNarrowServer, gridTheme, money, shortDate, subscribeNarrow } from "./grid-setup";

type StatusKey = "overdue" | "draft" | "sent" | "paid" | "partial" | "cancelled" | "other";

export interface InvoiceRow extends InvoiceWithAging {
  client: string;
  statusKey: StatusKey;
  statusLabel: string;
  /** True only for the pinned totals row. */
  isTotal?: boolean;
}

export interface InvoicesGridContext {
  onDraftReminder: (id: string) => void;
  onSendDraft: (id: string) => Promise<void>;
}

const STATUS: Record<StatusKey, { label: string; className: string; rank: number }> = {
  overdue: { label: "Overdue", rank: 0, className: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300" },
  sent: { label: "Sent", rank: 1, className: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300" },
  partial: { label: "Partially paid", rank: 2, className: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
  draft: { label: "Draft", rank: 3, className: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700/60 dark:text-zinc-300" },
  paid: { label: "Paid", rank: 4, className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" },
  cancelled: { label: "Cancelled", rank: 5, className: "bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-800 dark:text-zinc-500" },
  other: { label: "Other", rank: 6, className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
};

function statusKeyOf(inv: InvoiceWithAging): StatusKey {
  if (inv.overdue) return "overdue";
  if (inv.status === "DRAFT") return "draft";
  if (PAID_STATUSES.has(inv.status)) return "paid";
  if (inv.status === "PARTIALLY_PAID" || inv.status === "MARKED_AS_PARTIALLY_PAID") return "partial";
  if (inv.status === "SENT" || inv.status === "UNPAID") return "sent";
  if (inv.status === "CANCELLED") return "cancelled";
  return "other";
}

export function toInvoiceRows(invoices: InvoiceWithAging[]): InvoiceRow[] {
  return invoices.map((inv) => {
    const statusKey = statusKeyOf(inv);
    return {
      ...inv,
      client: clientOf(inv),
      statusKey,
      statusLabel: statusKey === "other" ? inv.status.replace(/_/g, " ").toLowerCase() : STATUS[statusKey].label,
    };
  });
}

/** Quick-filter chips, implemented with AG Grid's external filter. */
export type ChipKey = "all" | "overdue" | "open" | "paid" | "draft";
const CHIPS: { key: ChipKey; label: string; test: (r: InvoiceRow) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "overdue", label: "Overdue", test: (r) => r.statusKey === "overdue" },
  { key: "open", label: "Awaiting payment", test: (r) => r.statusKey === "sent" || r.statusKey === "partial" },
  { key: "paid", label: "Paid", test: (r) => r.statusKey === "paid" },
  { key: "draft", label: "Drafts", test: (r) => r.statusKey === "draft" },
];

// ---------- Cell renderers ----------

function StatusCell({ data }: CustomCellRendererProps<InvoiceRow>) {
  if (!data || data.isTotal) return null;
  const s = STATUS[data.statusKey];
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold leading-5 ${s.className}`}>
      {data.statusLabel}
    </span>
  );
}

function ActionsCell({ data, context }: CustomCellRendererProps<InvoiceRow, unknown, InvoicesGridContext>) {
  const [state, setState] = useState<"idle" | "confirm" | "sending" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!data || data.isTotal) return null;

  if (data.statusKey === "overdue") {
    return (
      <button
        type="button"
        onClick={() => context.onDraftReminder(data.id)}
        className="rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 transition hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300 dark:hover:bg-indigo-500/20"
      >
        Draft reminder
      </button>
    );
  }

  if (data.statusKey === "draft") {
    const send = async () => {
      if (state !== "confirm") {
        setState("confirm");
        return;
      }
      setState("sending");
      setError(null);
      try {
        await context.onSendDraft(data.id);
        // The grid reloads with the new status; this cell then unmounts or re-renders.
      } catch (err) {
        setError(err instanceof Error ? err.message : "Send failed.");
        setState("error");
      }
    };
    return (
      <span className="inline-flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void send()}
          onBlur={() => state === "confirm" && setState("idle")}
          disabled={state === "sending"}
          title={error ?? (state === "confirm" ? "Click again to email this invoice to the client" : "Send this draft via PayPal")}
          className={`rounded-lg px-2.5 py-1 text-xs font-medium transition disabled:opacity-60 ${
            state === "confirm"
              ? "bg-indigo-600 text-white hover:bg-indigo-500"
              : state === "error"
                ? "border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
                : "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          }`}
        >
          {state === "sending" ? "Sending…" : state === "confirm" ? "Confirm send" : state === "error" ? "Retry send" : "Send"}
        </button>
      </span>
    );
  }
  return null;
}

// ---------- Grid ----------

const isTotal = (p: { data?: InvoiceRow }) => !!p.data?.isTotal;
const moneyFormatter = (p: ValueFormatterParams<InvoiceRow, number>) => money(p.value, p.data?.currency ?? "USD");
const dateFormatter = (p: ValueFormatterParams<InvoiceRow, string | null>) => shortDate(p.value) || "—";

const rowClassRules: RowClassRules<InvoiceRow> = {
  "ip-row-overdue": (p) => !!p.data && !p.data.isTotal && p.data.statusKey === "overdue",
  "ip-row-muted": (p) => !!p.data && !p.data.isTotal && (p.data.statusKey === "paid" || p.data.statusKey === "cancelled"),
  "ip-row-total": isTotal,
};

export default function InvoicesGrid({
  rows,
  context,
  today,
}: {
  rows: InvoiceRow[];
  context: InvoicesGridContext;
  today: string;
}) {
  const apiRef = useRef<GridApi<InvoiceRow> | null>(null);
  const chipRef = useRef<ChipKey>("all");
  const [chip, setChip] = useState<ChipKey>("all");
  const [quickFilter, setQuickFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(rows.length);
  const narrow = useSyncExternalStore(subscribeNarrow, getNarrow, getNarrowServer);

  const chipCounts = useMemo(
    () => Object.fromEntries(CHIPS.map((c) => [c.key, rows.filter(c.test).length])) as Record<ChipKey, number>,
    [rows]
  );

  const columnDefs = useMemo<ColDef<InvoiceRow>[]>(
    () => [
      {
        field: "number",
        headerName: "Invoice #",
        pinned: "left",
        width: narrow ? 92 : 112,
        minWidth: 88,
        filter: "agTextColumnFilter",
        valueFormatter: (p) => (p.data?.isTotal ? "Total" : p.value ? `#${p.value}` : "—"),
        cellClass: "font-medium tabular-nums",
      },
      {
        field: "client",
        headerName: "Client",
        flex: 1.4,
        minWidth: 140,
        filter: "agTextColumnFilter",
        tooltip: (p) => (p.data?.isTotal ? undefined : (p.data?.recipientEmail ?? undefined)),
      },
      {
        field: "statusLabel",
        headerName: "Status",
        minWidth: 128,
        flex: 1,
        cellRenderer: StatusCell,
        filter: "agTextColumnFilter",
        // Sort by urgency, not alphabetically.
        comparator: (_a, _b, nodeA, nodeB) =>
          STATUS[nodeA.data?.statusKey ?? "other"].rank - STATUS[nodeB.data?.statusKey ?? "other"].rank,
      },
      {
        field: "total",
        headerName: "Amount",
        type: "rightAligned",
        minWidth: 110,
        flex: 1,
        filter: "agNumberColumnFilter",
        valueFormatter: moneyFormatter,
        useValueFormatterForExport: false,
        cellClass: "tabular-nums",
      },
      {
        field: "amountDue",
        headerName: "Balance due",
        type: "rightAligned",
        minWidth: 116,
        flex: 1,
        hide: narrow,
        filter: "agNumberColumnFilter",
        valueFormatter: moneyFormatter,
        useValueFormatterForExport: false,
        cellClass: "tabular-nums",
      },
      {
        field: "invoiceDate",
        headerName: "Invoice date",
        minWidth: 124,
        flex: 1,
        hide: narrow,
        filter: "agDateColumnFilter",
        filterParams: { comparator: compareIsoDate },
        valueFormatter: dateFormatter,
        useValueFormatterForExport: false,
      },
      {
        field: "dueDate",
        headerName: "Due date",
        minWidth: 118,
        flex: 1,
        filter: "agDateColumnFilter",
        filterParams: { comparator: compareIsoDate },
        valueFormatter: dateFormatter,
        useValueFormatterForExport: false,
        sort: "asc",
        sortIndex: 1,
      },
      {
        field: "daysOverdue",
        headerName: "Days overdue",
        type: "rightAligned",
        minWidth: 124,
        flex: 1,
        filter: "agNumberColumnFilter",
        sort: "desc",
        sortIndex: 0,
        valueFormatter: (p) => (p.data?.isTotal ? (p.value ? `avg ${p.value}` : "") : p.value ? `${p.value} days` : "—"),
        useValueFormatterForExport: false,
        cellClass: "tabular-nums",
        // Urgency highlight, matching the reminder tone tiers (1-7 / 8-30 / 31+).
        cellClassRules: {
          "ip-days-friendly": (p) => !p.data?.isTotal && p.value >= 1 && p.value <= 7,
          "ip-days-firm": (p) => !p.data?.isTotal && p.value >= 8 && p.value <= 30,
          "ip-days-final": (p) => !p.data?.isTotal && p.value > 30,
        },
      },
      {
        colId: "actions",
        headerName: "",
        pinned: narrow ? undefined : "right",
        width: 140,
        minWidth: 132,
        sortable: false,
        filter: false,
        resizable: false,
        suppressMovable: true,
        cellRenderer: ActionsCell,
      },
    ],
    [narrow]
  );

  const defaultColDef = useMemo<ColDef<InvoiceRow>>(() => ({ sortable: true, resizable: true, filter: true }), []);

  /** Recomputes the pinned totals row from the rows that pass all filters. */
  const updateTotals = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    let count = 0;
    let total = 0;
    let due = 0;
    let overdueDays = 0;
    let overdueCount = 0;
    api.forEachNodeAfterFilter((node: IRowNode<InvoiceRow>) => {
      const d = node.data;
      if (!d) return;
      count++;
      total += d.total;
      due += d.statusKey === "draft" ? 0 : d.amountDue;
      if (d.overdue) {
        overdueDays += d.daysOverdue;
        overdueCount++;
      }
    });
    setVisibleCount(count);
    const totalRow = {
      id: "__total",
      isTotal: true,
      number: "Total",
      client: `${count} invoice${count === 1 ? "" : "s"}`,
      total: Math.round(total * 100) / 100,
      amountDue: Math.round(due * 100) / 100,
      daysOverdue: overdueCount ? Math.round(overdueDays / overdueCount) : 0,
      currency: "USD",
    } as InvoiceRow;
    api.setGridOption("pinnedBottomRowData", [totalRow]);
  }, []);

  const onGridReady = useCallback(
    (e: GridReadyEvent<InvoiceRow>) => {
      apiRef.current = e.api;
      updateTotals();
    },
    [updateTotals]
  );

  const selectChip = (key: ChipKey) => {
    chipRef.current = key;
    setChip(key);
    apiRef.current?.onFilterChanged();
  };

  const isExternalFilterPresent = useCallback(() => chipRef.current !== "all", []);
  const doesExternalFilterPass = useCallback((node: IRowNode<InvoiceRow>) => {
    const test = CHIPS.find((c) => c.key === chipRef.current)?.test;
    return !node.data || !test || test(node.data);
  }, []);

  const exportCsv = () =>
    apiRef.current?.exportDataAsCsv({
      fileName: `invoicepilot-invoices-${today}.csv`,
      columnKeys: ["number", "client", "statusLabel", "total", "amountDue", "invoiceDate", "dueDate", "daysOverdue"],
      skipPinnedBottom: true,
    });

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 sm:pb-0" role="group" aria-label="Filter by status">
          {CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => selectChip(c.key)}
              aria-pressed={chip === c.key}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition ${
                chip === c.key
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {c.label}
              <span className={`ml-1.5 tabular-nums ${chip === c.key ? "text-indigo-100" : "text-zinc-400"}`}>
                {chipCounts[c.key]}
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="invoice-search" className="sr-only">
            Search invoices
          </label>
          <div className="relative flex-1 sm:w-60 sm:flex-none">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="m20 20-3.5-3.5" />
            </svg>
            <input
              id="invoice-search"
              type="search"
              value={quickFilter}
              onChange={(e) => setQuickFilter(e.target.value)}
              placeholder="Search client, #, status…"
              className="w-full rounded-lg border border-zinc-300 bg-white py-1.5 pl-8 pr-3 text-base focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 sm:text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
          <button
            type="button"
            onClick={exportCsv}
            className="shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Export CSV
          </button>
        </div>
      </div>

      <AgGridReact<InvoiceRow>
        theme={gridTheme}
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        context={context}
        getRowId={(p) => p.data.id}
        rowClassRules={rowClassRules}
        quickFilterText={quickFilter}
        isExternalFilterPresent={isExternalFilterPresent}
        doesExternalFilterPass={doesExternalFilterPass}
        onGridReady={onGridReady}
        onModelUpdated={updateTotals}
        domLayout="autoHeight"
        pagination={rows.length > 20}
        paginationPageSize={20}
        paginationPageSizeSelector={[20, 50, 100]}
        tooltipShowDelay={400}
        overlayNoRowsTemplate='<span class="text-sm">No invoices match these filters.</span>'
        animateRows
      />

      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400">
        Showing {visibleCount} of {rows.length} invoices · sorted by most overdue · totals reflect current filters
      </p>
    </div>
  );
}
