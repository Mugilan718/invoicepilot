"use client";

import { useEffect, useState } from "react";
import type { InvoicesResponse, InvoiceWithAging, ReminderDraft, ReminderTier } from "@/lib/types";

type ReminderState = "editing" | "sending" | "sent" | "skipped";

interface ReminderUI {
  subject: string;
  note: string;
  aiDrafted: boolean;
  state: ReminderState;
  sentAt?: string;
  error?: string;
}

const money = (n: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);

const shortDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
};

const TIER: Record<ReminderTier, { label: string; className: string }> = {
  friendly: {
    label: "Gentle nudge",
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
  firm: {
    label: "Firm",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  },
  final: {
    label: "Urgent",
    className: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
  },
};

const clientName = (inv: InvoiceWithAging) => inv.recipientName ?? inv.recipientEmail ?? "Unknown client";

async function readJson<T>(res: Response): Promise<T & { error?: string }> {
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !data || data.error) throw new Error(data?.error || `Request failed (${res.status}).`);
  return data;
}

const friendlyError = (err: unknown, fallback: string) =>
  err instanceof TypeError
    ? "Couldn't reach the server. Check your connection and try again."
    : err instanceof Error
      ? err.message
      : fallback;

export default function FollowUps() {
  const [data, setData] = useState<InvoicesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [reminders, setReminders] = useState<Record<string, ReminderUI>>({});

  // Bumped by "Refresh"/"Try again" to refetch.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/invoices", { cache: "no-store" })
      .then((res) => readJson<InvoicesResponse>(res))
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(friendlyError(err, "Couldn't load invoices."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    setReloadKey((k) => k + 1);
  };

  const overdue = (data?.invoices ?? [])
    .filter((i) => i.overdue)
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
  const upcoming = (data?.invoices ?? [])
    .filter((i) => !i.overdue && ["SENT", "UNPAID", "PARTIALLY_PAID"].includes(i.status))
    .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
  const outstanding = overdue.reduce((s, i) => s + i.amountDue, 0);

  async function draftAll() {
    setDrafting(true);
    setDraftError(null);
    try {
      // Only (re)draft invoices that haven't been sent or skipped yet.
      const ids = overdue
        .filter((i) => !["sent", "sending", "skipped"].includes(reminders[i.id]?.state ?? ""))
        .map((i) => i.id);
      if (ids.length === 0) return;
      const res = await fetch("/api/reminders/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const { reminders: drafts } = await readJson<{ reminders: ReminderDraft[] }>(res);
      setReminders((prev) => {
        const next = { ...prev };
        for (const d of drafts) {
          next[d.id] = { subject: d.subject, note: d.note, aiDrafted: d.aiDrafted, state: "editing" };
        }
        return next;
      });
    } catch (err) {
      setDraftError(friendlyError(err, "Couldn't draft reminders."));
    } finally {
      setDrafting(false);
    }
  }

  const patch = (id: string, p: Partial<ReminderUI>) =>
    setReminders((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...p } } : prev));

  async function sendReminder(id: string) {
    const r = reminders[id];
    if (!r || !r.note.trim()) {
      patch(id, { error: "Write a short note before sending." });
      return;
    }
    patch(id, { state: "sending", error: undefined });
    try {
      const res = await fetch("/api/reminders/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, subject: r.subject, note: r.note }),
      });
      const { sentAt } = await readJson<{ sentAt: string }>(res);
      patch(id, { state: "sent", sentAt });
    } catch (err) {
      patch(id, { state: "editing", error: friendlyError(err, "Sending failed.") });
    }
  }

  const hasPendingDrafts = overdue.some((i) => !reminders[i.id] || reminders[i.id].state === "editing");

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
        {/* Title row */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Follow-ups</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {data && overdue.length > 0
                ? `${overdue.length} overdue invoice${overdue.length === 1 ? "" : "s"} · ${money(outstanding)} outstanding`
                : "Overdue invoices and AI-drafted payment reminders."}
              {data?.demo && ` · as of ${shortDate(data.today)}`}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="rounded-xl border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Refresh
            </button>
            {overdue.length > 0 && (
              <button
                type="button"
                onClick={() => void draftAll()}
                disabled={drafting || loading || !hasPendingDrafts}
                className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-50"
              >
                {drafting ? <Spinner /> : <Sparkle />}
                {drafting ? "Drafting…" : "Draft reminders with AI"}
              </button>
            )}
          </div>
        </div>

        {draftError && <ErrorBox>{draftError}</ErrorBox>}

        {/* States */}
        {loading && !data && <SkeletonList />}
        {loadError && (
          <ErrorBox>
            {loadError}{" "}
            <button type="button" onClick={() => void load()} className="font-medium underline">
              Try again
            </button>
          </ErrorBox>
        )}

        {data && overdue.length === 0 && (
          <div className="flex flex-col items-center rounded-2xl border border-dashed border-zinc-300 bg-white px-6 py-14 text-center dark:border-zinc-700 dark:bg-zinc-900">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-6 w-6" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" />
              </svg>
            </div>
            <p className="mt-4 text-lg font-semibold">All caught up! No overdue invoices.</p>
            <p className="mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
              When a sent invoice passes its due date, it will show up here with a ready-to-edit reminder.
            </p>
          </div>
        )}

        {/* Overdue list */}
        {overdue.length > 0 && (
          <ul className="flex flex-col gap-3">
            {overdue.map((inv) => (
              <OverdueCard
                key={inv.id}
                invoice={inv}
                reminder={reminders[inv.id]}
                onChange={(p) => patch(inv.id, p)}
                onSend={() => void sendReminder(inv.id)}
                onSkip={() => patch(inv.id, { state: "skipped", error: undefined })}
                onUndoSkip={() => patch(inv.id, { state: "editing" })}
              />
            ))}
          </ul>
        )}

        {/* Upcoming */}
        {upcoming.length > 0 && (
          <section className="mt-2">
            <h2 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">Not yet due</h2>
            <ul className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
              {upcoming.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{clientName(inv)}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      #{inv.number ?? inv.id}
                      {inv.dueDate ? ` · due ${shortDate(inv.dueDate)}` : " · due on receipt"}
                    </p>
                  </div>
                  <p className="shrink-0 tabular-nums">{money(inv.amountDue, inv.currency)}</p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}

function OverdueCard({
  invoice,
  reminder,
  onChange,
  onSend,
  onSkip,
  onUndoSkip,
}: {
  invoice: InvoiceWithAging;
  reminder?: ReminderUI;
  onChange: (p: Partial<ReminderUI>) => void;
  onSend: () => void;
  onSkip: () => void;
  onUndoSkip: () => void;
}) {
  const tier = invoice.tier ? TIER[invoice.tier] : null;
  const sending = reminder?.state === "sending";

  return (
    <li className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold">{clientName(invoice)}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Invoice #{invoice.number ?? invoice.id}
            {invoice.dueDate && ` · due ${shortDate(invoice.dueDate)}`}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <p className="text-base font-semibold tabular-nums">{money(invoice.amountDue, invoice.currency)}</p>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
              {invoice.daysOverdue} day{invoice.daysOverdue === 1 ? "" : "s"} overdue
            </span>
            {tier && (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tier.className}`}>{tier.label}</span>
            )}
          </div>
        </div>
      </div>

      {reminder?.state === "sent" && (
        <div className="flex items-center gap-2 border-t border-zinc-100 px-4 py-3 text-sm text-emerald-700 dark:border-zinc-800 dark:text-emerald-400">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" />
          </svg>
          Reminder sent
          {reminder.sentAt &&
            ` at ${new Date(reminder.sentAt).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}`}
        </div>
      )}

      {reminder?.state === "skipped" && (
        <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-4 py-2.5 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          Skipped for now.
          <button type="button" onClick={onUndoSkip} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            Undo
          </button>
        </div>
      )}

      {(reminder?.state === "editing" || sending) && reminder && (
        <div className="flex flex-col gap-2 border-t border-zinc-100 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/30">
          <div className="flex items-center justify-between">
            <label htmlFor={`subject-${invoice.id}`} className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Subject
            </label>
            {!reminder.aiDrafted && (
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500">Template (AI skipped this one)</span>
            )}
          </div>
          <input
            id={`subject-${invoice.id}`}
            value={reminder.subject}
            onChange={(e) => onChange({ subject: e.target.value })}
            disabled={sending}
            maxLength={150}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 sm:text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
          <label htmlFor={`note-${invoice.id}`} className="mt-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Note
          </label>
          <textarea
            id={`note-${invoice.id}`}
            value={reminder.note}
            onChange={(e) => onChange({ note: e.target.value })}
            disabled={sending}
            rows={6}
            maxLength={1200}
            className="resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base leading-relaxed focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 sm:text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
          {reminder.error && <ErrorBox>{reminder.error}</ErrorBox>}
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              onClick={onSend}
              disabled={sending || !reminder.note.trim()}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-60 sm:flex-none"
            >
              {sending && <Spinner />}
              {sending ? "Sending…" : "Send reminder"}
            </button>
            <button
              type="button"
              onClick={onSkip}
              disabled={sending}
              className="rounded-xl border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Skip
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
      {children}
    </p>
  );
}

function SkeletonList() {
  return (
    <ul className="flex flex-col gap-3" aria-busy="true" aria-label="Loading invoices">
      {[0, 1, 2].map((i) => (
        <li key={i} className="h-20 animate-pulse rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900" />
      ))}
    </ul>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity={0.25} strokeWidth={4} />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth={4} strokeLinecap="round" />
    </svg>
  );
}

function Sparkle() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden>
      <path d="M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6L12 2Zm6 12 .9 2.6L21.5 17l-2.6.9L18 20.5l-.9-2.6-2.6-.9 2.6-.9L18 14Z" />
    </svg>
  );
}
