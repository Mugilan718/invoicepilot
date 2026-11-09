// Cash-flow and per-client stats, computed in code (no AI). Pure functions: used by the
// dashboard in the browser and by the insights API on the server, so both see the same numbers.

import { addDays, daysBetween } from "@/lib/demo-clock";
import type { InvoiceWithAging } from "@/lib/types";

/** Money is still owed on these. */
export const OPEN_STATUSES = new Set(["SENT", "UNPAID", "PARTIALLY_PAID"]);
export const PAID_STATUSES = new Set(["PAID", "MARKED_AS_PAID"]);
/** Never billed (or withdrawn); excluded from "total billed". */
const NOT_BILLED = new Set(["DRAFT", "SCHEDULED", "CANCELLED"]);

export type Reliability = "Reliable" | "Sometimes late" | "Often late" | "No history";

export interface KpiStats {
  outstanding: number;
  outstandingCount: number;
  overdueAmount: number;
  overdueCount: number;
  paidLast30: number;
  paidLast30Count: number;
  avgDaysOverdue: number;
  maxDaysOverdue: number;
  draftCount: number;
  draftAmount: number;
}

export interface ClientStats {
  client: string;
  invoiceCount: number;
  totalBilled: number;
  outstanding: number;
  /** Currently overdue + paid after the due date. */
  lateCount: number;
  /** Average days late across late invoices (0 if none). */
  avgDaysLate: number;
  maxDaysLate: number;
  paidOnTimeCount: number;
  paidLateCount: number;
  overdueCount: number;
  reliability: Reliability;
}

export const clientOf = (inv: InvoiceWithAging) => inv.recipientName ?? inv.recipientEmail ?? "Unknown client";

/** Days a paid invoice was paid after its due date (0 if on time or unknown). */
export function daysPaidLate(inv: InvoiceWithAging): number {
  if (!inv.paidDate || !inv.dueDate) return 0;
  return Math.max(0, daysBetween(inv.dueDate, inv.paidDate));
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function computeKpis(invoices: InvoiceWithAging[], today: string): KpiStats {
  const open = invoices.filter((i) => OPEN_STATUSES.has(i.status));
  const overdue = invoices.filter((i) => i.overdue);
  const since = addDays(today, -30);
  const paidRecently = invoices.filter((i) => i.amountPaid > 0 && i.paidDate && i.paidDate > since && i.paidDate <= today);
  const drafts = invoices.filter((i) => i.status === "DRAFT");

  return {
    outstanding: round2(open.reduce((s, i) => s + i.amountDue, 0)),
    outstandingCount: open.length,
    overdueAmount: round2(overdue.reduce((s, i) => s + i.amountDue, 0)),
    overdueCount: overdue.length,
    paidLast30: round2(paidRecently.reduce((s, i) => s + i.amountPaid, 0)),
    paidLast30Count: paidRecently.length,
    avgDaysOverdue: Math.round(avg(overdue.map((i) => i.daysOverdue))),
    maxDaysOverdue: overdue.reduce((m, i) => Math.max(m, i.daysOverdue), 0),
    draftCount: drafts.length,
    draftAmount: round2(drafts.reduce((s, i) => s + i.total, 0)),
  };
}

/**
 * Payment reliability from history:
 * - "considered" = paid invoices with a known payment date + currently overdue invoices
 *   (open invoices that aren't due yet tell us nothing).
 * - Often late:     at least half of considered invoices were late.
 * - Reliable:       at most 1 in 4 late, and never more than 14 days late.
 * - Sometimes late: everything in between.
 */
export function reliabilityFor(considered: number, late: number, maxDaysLate: number): Reliability {
  if (considered === 0) return "No history";
  const rate = late / considered;
  if (rate >= 0.5) return "Often late";
  if (rate <= 0.25 && maxDaysLate <= 14) return "Reliable";
  return "Sometimes late";
}

export function computeClientStats(invoices: InvoiceWithAging[]): ClientStats[] {
  const byClient = new Map<string, InvoiceWithAging[]>();
  for (const inv of invoices) {
    const key = clientOf(inv);
    byClient.set(key, [...(byClient.get(key) ?? []), inv]);
  }

  return [...byClient.entries()]
    .map(([client, list]) => {
      const billed = list.filter((i) => !NOT_BILLED.has(i.status));
      const paidWithDates = list.filter((i) => PAID_STATUSES.has(i.status) && i.paidDate && i.dueDate);
      const paidLate = paidWithDates.filter((i) => daysPaidLate(i) > 0);
      const overdue = list.filter((i) => i.overdue);
      const lateDays = [...paidLate.map(daysPaidLate), ...overdue.map((i) => i.daysOverdue)];
      const maxDaysLate = lateDays.reduce((m, d) => Math.max(m, d), 0);
      const considered = paidWithDates.length + overdue.length;

      return {
        client,
        invoiceCount: billed.length,
        totalBilled: round2(billed.reduce((s, i) => s + i.total, 0)),
        outstanding: round2(list.filter((i) => OPEN_STATUSES.has(i.status)).reduce((s, i) => s + i.amountDue, 0)),
        lateCount: lateDays.length,
        avgDaysLate: Math.round(avg(lateDays)),
        maxDaysLate,
        paidOnTimeCount: paidWithDates.length - paidLate.length,
        paidLateCount: paidLate.length,
        overdueCount: overdue.length,
        reliability: reliabilityFor(considered, lateDays.length, maxDaysLate),
      };
    })
    .sort((a, b) => b.outstanding - a.outstanding || b.totalBilled - a.totalBilled);
}
