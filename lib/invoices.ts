import { daysBetween, getToday } from "@/lib/demo-clock";
import type { InvoiceRecord, InvoiceWithAging, ReminderTier } from "@/lib/types";

/** Statuses where money is still owed and a reminder makes sense. */
export const OPEN_STATUSES = new Set(["SENT", "UNPAID", "PARTIALLY_PAID"]);

export function tierFor(daysOverdue: number): ReminderTier | null {
  if (daysOverdue <= 0) return null;
  if (daysOverdue <= 7) return "friendly";
  if (daysOverdue <= 30) return "firm";
  return "final";
}

export function withAging(inv: InvoiceRecord, today: string = getToday()): InvoiceWithAging {
  const daysPastDue = inv.dueDate ? daysBetween(inv.dueDate, today) : 0;
  const overdue = OPEN_STATUSES.has(inv.status) && daysPastDue > 0;
  const daysOverdue = overdue ? daysPastDue : 0;
  return { ...inv, overdue, daysOverdue, tier: tierFor(daysOverdue) };
}
