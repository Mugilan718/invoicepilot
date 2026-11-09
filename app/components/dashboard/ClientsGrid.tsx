"use client";

import { useMemo } from "react";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import type { ColDef, ValueFormatterParams } from "ag-grid-community";
import type { ClientStats, Reliability } from "@/lib/stats";
import { gridTheme, money } from "./grid-setup";

type ClientRow = ClientStats & { isTotal?: boolean };

const RELIABILITY: Record<Reliability, string> = {
  Reliable: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  "Sometimes late": "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  "Often late": "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
  "No history": "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const RELIABILITY_RANK: Record<Reliability, number> = { "Often late": 0, "Sometimes late": 1, Reliable: 2, "No history": 3 };

function ReliabilityCell({ data }: CustomCellRendererProps<ClientRow>) {
  if (!data || data.isTotal) return null;
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold leading-5 ${RELIABILITY[data.reliability]}`}>
      {data.reliability}
    </span>
  );
}

const moneyFmt = (p: ValueFormatterParams<ClientRow, number>) => money(p.value);

function historyTooltip(c: ClientRow): string {
  const parts = [
    `${c.paidOnTimeCount} paid on time`,
    `${c.paidLateCount} paid late`,
    `${c.overdueCount} currently overdue`,
  ];
  return `${parts.join(" · ")}${c.maxDaysLate ? ` · worst: ${c.maxDaysLate} days late` : ""}`;
}

export default function ClientsGrid({ clients }: { clients: ClientStats[] }) {
  const columnDefs = useMemo(
    (): ColDef<ClientRow>[] => [
      { field: "client", headerName: "Client", pinned: "left", minWidth: 140, flex: 1.4, filter: "agTextColumnFilter", cellClass: "font-medium" },
      {
        field: "reliability",
        headerName: "Payment reliability",
        minWidth: 160,
        flex: 1.2,
        cellRenderer: ReliabilityCell,
        filter: "agTextColumnFilter",
        tooltipValueGetter: (p) => (p.data && !p.data.isTotal ? historyTooltip(p.data) : undefined),
        comparator: (a: Reliability, b: Reliability) => (RELIABILITY_RANK[a] ?? 9) - (RELIABILITY_RANK[b] ?? 9),
      },
      { field: "invoiceCount", headerName: "Invoices", type: "rightAligned", minWidth: 96, flex: 0.8, filter: "agNumberColumnFilter" },
      { field: "totalBilled", headerName: "Total billed", type: "rightAligned", minWidth: 120, flex: 1, filter: "agNumberColumnFilter", valueFormatter: moneyFmt, cellClass: "tabular-nums" },
      {
        field: "outstanding",
        headerName: "Outstanding",
        type: "rightAligned",
        minWidth: 120,
        flex: 1,
        filter: "agNumberColumnFilter",
        valueFormatter: moneyFmt,
        sort: "desc",
        cellClass: "tabular-nums",
      },
      {
        field: "lateCount",
        headerName: "Late invoices",
        type: "rightAligned",
        minWidth: 116,
        flex: 0.9,
        filter: "agNumberColumnFilter",
        cellClassRules: { "ip-days-firm": (p) => !p.data?.isTotal && p.value > 0 },
      },
      {
        field: "avgDaysLate",
        headerName: "Avg days late",
        type: "rightAligned",
        minWidth: 124,
        flex: 0.9,
        filter: "agNumberColumnFilter",
        valueFormatter: (p) => (p.data?.isTotal ? "" : p.value ? `${p.value} days` : "—"),
        cellClassRules: {
          "ip-days-friendly": (p) => !p.data?.isTotal && p.value >= 1 && p.value <= 7,
          "ip-days-firm": (p) => !p.data?.isTotal && p.value >= 8 && p.value <= 30,
          "ip-days-final": (p) => !p.data?.isTotal && p.value > 30,
        },
      },
    ],
    []
  );

  const pinnedBottomRowData = useMemo<ClientRow[]>(() => {
    const sum = (f: (c: ClientStats) => number) => Math.round(clients.reduce((s, c) => s + f(c), 0) * 100) / 100;
    return [
      {
        client: `Total (${clients.length})`,
        isTotal: true,
        invoiceCount: sum((c) => c.invoiceCount),
        totalBilled: sum((c) => c.totalBilled),
        outstanding: sum((c) => c.outstanding),
        lateCount: sum((c) => c.lateCount),
      } as ClientRow,
    ];
  }, [clients]);

  return (
    <AgGridReact<ClientRow>
      theme={gridTheme}
      rowData={clients}
      columnDefs={columnDefs}
      defaultColDef={{ sortable: true, resizable: true }}
      getRowId={(p) => p.data.client}
      pinnedBottomRowData={pinnedBottomRowData}
      rowClassRules={{ "ip-row-total": (p) => !!p.data?.isTotal }}
      domLayout="autoHeight"
      tooltipShowDelay={300}
    />
  );
}
