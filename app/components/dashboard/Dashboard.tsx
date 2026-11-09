"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { InvoicesResponse } from "@/lib/types";
import { computeClientStats, computeKpis } from "@/lib/stats";
import { GridProvider, money, shortDate, useGridThemeMode } from "./grid-setup";
import InvoicesGrid, { toInvoiceRows, type InvoicesGridContext } from "./InvoicesGrid";
import ClientsGrid from "./ClientsGrid";
import InsightsPanel from "./InsightsPanel";

async function readJson<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !data || data.error) throw new Error(data?.error || `Request failed (${res.status}).`);
  return data;
}

export default function Dashboard() {
  useGridThemeMode();
  const router = useRouter();
  const [data, setData] = useState<InvoicesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/invoices", { cache: "no-store" })
      .then((res) => readJson<InvoicesResponse>(res))
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof TypeError
            ? "Couldn't reach the server. Check your connection and try again."
            : err instanceof Error
              ? err.message
              : "Couldn't load invoices."
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  const invoices = useMemo(() => data?.invoices ?? [], [data]);
  const rows = useMemo(() => toInvoiceRows(invoices), [invoices]);
  const kpis = useMemo(() => (data ? computeKpis(invoices, data.today) : null), [data, invoices]);
  const clients = useMemo(() => computeClientStats(invoices.filter((i) => i.status !== "DRAFT")), [invoices]);

  const gridContext = useMemo<InvoicesGridContext>(
    () => ({
      onDraftReminder: (id) => router.push(`/follow-ups?invoice=${encodeURIComponent(id)}`),
      onSendDraft: async (id) => {
        const res = await fetch(`/api/invoices/${encodeURIComponent(id)}/send`, { method: "POST" });
        await readJson<{ success: boolean }>(res);
        reload();
      },
    }),
    [router, reload]
  );

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Cash-flow dashboard</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Live from your PayPal invoices{data ? ` · as of ${shortDate(data.today)}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={reload}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 11a8 8 0 0 0-14.9-4M4 5v3h3M4 13a8 8 0 0 0 14.9 4M20 19v-3h-3" />
            </svg>
            Refresh
          </button>
        </div>

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            {error}{" "}
            <button type="button" onClick={reload} className="font-medium underline">
              Try again
            </button>
          </p>
        )}

        {/* KPI cards */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Key figures">
          {kpis ? (
            <>
              <Kpi
                label="Total outstanding"
                value={money(kpis.outstanding, "USD", true)}
                sub={`${kpis.outstandingCount} unpaid invoice${kpis.outstandingCount === 1 ? "" : "s"}`}
              />
              <Kpi
                label="Overdue"
                value={money(kpis.overdueAmount, "USD", true)}
                sub={`${kpis.overdueCount} invoice${kpis.overdueCount === 1 ? "" : "s"} past due`}
                tone={kpis.overdueCount ? "danger" : "default"}
              />
              <Kpi
                label="Paid (last 30 days)"
                value={money(kpis.paidLast30, "USD", true)}
                sub={`${kpis.paidLast30Count} payment${kpis.paidLast30Count === 1 ? "" : "s"} received`}
                tone="success"
              />
              <Kpi
                label="Avg days overdue"
                value={kpis.overdueCount ? `${kpis.avgDaysOverdue} days` : "—"}
                sub={kpis.overdueCount ? `oldest: ${kpis.maxDaysOverdue} days` : "nothing overdue"}
                tone={kpis.avgDaysOverdue > 30 ? "danger" : kpis.avgDaysOverdue > 7 ? "warning" : "default"}
              />
            </>
          ) : (
            [0, 1, 2, 3].map((i) => (
              <div key={i} className="h-[104px] animate-pulse rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900" />
            ))
          )}
        </section>

        {kpis && kpis.draftCount > 0 && (
          <p className="-mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            Plus {kpis.draftCount} unsent draft{kpis.draftCount === 1 ? "" : "s"} worth {money(kpis.draftAmount)}, not counted above.
          </p>
        )}

        <InsightsPanel disabled={!data || invoices.length === 0} />

        <GridProvider>
          <section className="flex flex-col gap-3">
            <SectionTitle title="All invoices" hint="Sort, filter from any column header, or search. Overdue rows are highlighted." />
            {data ? (
              <InvoicesGrid rows={rows} context={gridContext} today={data.today} />
            ) : (
              <GridSkeleton rows={6} />
            )}
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle
              title="Clients"
              hint="Reliability is computed from payment history: hover a label to see why."
            />
            {data ? <ClientsGrid clients={clients} /> : <GridSkeleton rows={3} />}
          </section>
        </GridProvider>
      </div>
    </main>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "default" | "danger" | "warning" | "success";
}) {
  const accent = {
    default: "text-zinc-900 dark:text-zinc-100",
    danger: "text-red-600 dark:text-red-400",
    warning: "text-amber-600 dark:text-amber-400",
    success: "text-emerald-600 dark:text-emerald-400",
  }[tone];
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums tracking-tight ${accent}`}>{value}</p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{sub}</p>
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
    </div>
  );
}

function GridSkeleton({ rows }: { rows: number }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900" aria-busy="true">
      <div className="h-10 border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/40" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-4 border-b border-zinc-100 px-4 last:border-0 dark:border-zinc-800">
          <div className="h-3 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-3 flex-1 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800/70" />
          <div className="h-3 w-20 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>
      ))}
    </div>
  );
}
