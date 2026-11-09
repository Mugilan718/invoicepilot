"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AgentResponse, ChatMessage, InvoiceSummary } from "@/lib/types";

type CardState = "open" | "sending" | "sent" | "discarded";

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Failed request notice; shown in chat but not sent back to the model. */
  isError?: boolean;
  invoice?: InvoiceSummary;
  card?: { state: CardState; error?: string };
}

const EXAMPLES = [
  "Bill Acme Corp $1,200 for logo design, due in 14 days",
  "Invoice Bloom Bakery for 10 hours of web design at $85/hour, due next Friday",
  "Nova Studio owes me $450 for a brand style guide and $300 for social templates",
];

const money = (n: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

let idCounter = 0;
const newId = () => `m${Date.now()}-${idCounter++}`;

/** Builds the history sent to the agent, with invoice context so the model knows what already happened. */
function toHistory(messages: UIMessage[]): ChatMessage[] {
  return messages
    .filter((m) => !m.isError)
    .map((m) => {
      if (!m.invoice) return { role: m.role, content: m.content };
      const inv = m.invoice;
      const state =
        m.card?.state === "sent"
          ? "the user approved and sent it"
          : m.card?.state === "discarded"
            ? "the user discarded it"
            : "awaiting user approval";
      return {
        role: m.role,
        content: `${m.content}\n\n[Draft invoice ${inv.number ?? inv.id} for ${inv.client}, total ${money(inv.total)}: ${state}.]`,
      };
    });
}

export default function Chat() {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  // Switch to a "still working" message if the agent takes longer than ~5s.
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setSlow(true), 5000);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [loading]);

  // Auto-grow the textarea.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const updateMessage = (id: string, patch: (m: UIMessage) => UIMessage) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));

  async function send(text: string) {
    const content = text.trim();
    if (!content || loading) return;

    const userMsg: UIMessage = { id: newId(), role: "user", content };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: toHistory(next) }),
      });
      const data = (await res.json().catch(() => null)) as
        | (AgentResponse & { error?: string })
        | null;

      if (!res.ok || !data || data.error) {
        throw new Error(data?.error || `Request failed (${res.status}).`);
      }

      setMessages((prev) => [
        ...prev,
        {
          id: newId(),
          role: "assistant",
          content: data.reply,
          invoice: data.invoice,
          card: data.invoice ? { state: "open" } : undefined,
        },
      ]);
    } catch (err) {
      const msg =
        err instanceof TypeError
          ? "Couldn't reach the server. Check your connection and try again."
          : err instanceof Error
            ? err.message
            : "Something went wrong.";
      setMessages((prev) => [...prev, { id: newId(), role: "assistant", content: msg, isError: true }]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  async function approve(msg: UIMessage) {
    if (!msg.invoice) return;
    updateMessage(msg.id, (m) => ({ ...m, card: { state: "sending" } }));
    try {
      const res = await fetch(`/api/invoices/${encodeURIComponent(msg.invoice.id)}/send`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as
        | { success: boolean; status?: string; error?: string }
        | null;
      if (!res.ok || !data?.success) throw new Error(data?.error || `Send failed (${res.status}).`);
      updateMessage(msg.id, (m) => ({
        ...m,
        invoice: m.invoice && { ...m.invoice, status: data.status || "SENT" },
        card: { state: "sent" },
      }));
    } catch (err) {
      const error =
        err instanceof TypeError
          ? "Couldn't reach the server. Try again."
          : err instanceof Error
            ? err.message
            : "Sending failed.";
      updateMessage(msg.id, (m) => ({ ...m, card: { state: "open", error } }));
    }
  }

  function discard(msg: UIMessage) {
    updateMessage(msg.id, (m) => ({ ...m, card: { state: "discarded" } }));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  }

  const empty = messages.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">

      {/* Messages */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
          {empty && (
            <div className="flex flex-col items-center py-10 text-center sm:py-16">
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Who are we billing today?</h1>
              <p className="mt-2 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
                Tell me the client, what you did and how much. I&apos;ll create a draft for you to review.
                Nothing is sent until you approve it.
              </p>
              <div className="mt-8 grid w-full max-w-xl gap-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => void send(ex)}
                    disabled={loading}
                    className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-left text-sm text-zinc-700 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50/50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-indigo-500/50 dark:hover:bg-indigo-500/10"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className={`flex flex-col gap-2 ${m.role === "user" ? "items-end" : "items-start"}`}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed sm:max-w-[75%] ${
                  m.role === "user"
                    ? "rounded-br-md bg-indigo-600 text-white"
                    : m.isError
                      ? "rounded-bl-md border border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
                      : "rounded-bl-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
                }`}
              >
                {m.content}
              </div>
              {m.invoice && m.card && (
                <InvoiceCard
                  invoice={m.invoice}
                  state={m.card.state}
                  error={m.card.error}
                  onApprove={() => void approve(m)}
                  onDiscard={() => discard(m)}
                />
              )}
            </div>
          ))}

          {loading && (
            <div className="flex items-start">
              <div
                role="status"
                className="flex items-center gap-3 rounded-2xl rounded-bl-md border border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <span className="flex gap-1" aria-hidden>
                  {[0, 150, 300].map((d) => (
                    <span
                      key={d}
                      className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400"
                      style={{ animationDelay: `${d}ms` }}
                    />
                  ))}
                </span>
                <span className="text-sm text-zinc-500 dark:text-zinc-400">
                  {slow ? "Still working, the AI service is busy..." : "Drafting your invoice..."}
                </span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      {/* Input */}
      <footer className="shrink-0 border-t border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
        <form onSubmit={onSubmit} className="mx-auto flex max-w-3xl items-end gap-2 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <label htmlFor="chat-input" className="sr-only">
            Message InvoicePilot
          </label>
          <textarea
            id="chat-input"
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="e.g. Bill Acme Corp $1,200 for logo design, due in 14 days"
            className="min-h-11 flex-1 resize-none rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-base text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 sm:text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            aria-label="Send message"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? (
              <Spinner />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            )}
          </button>
        </form>
      </footer>
    </div>
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

function StatusBadge({ status }: { status: string }) {
  const s = status.toUpperCase();
  const styles =
    s === "DRAFT"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
      : s === "SENDING"
        ? "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300"
        : s === "PAID"
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
          : "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300";
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide ${styles}`}>
      {s.replace(/_/g, " ")}
    </span>
  );
}

function InvoiceCard({
  invoice,
  state,
  error,
  onApprove,
  onDiscard,
}: {
  invoice: InvoiceSummary;
  state: CardState;
  error?: string;
  onApprove: () => void;
  onDiscard: () => void;
}) {
  if (state === "discarded") {
    return (
      <p className="px-1 text-xs text-zinc-400 dark:text-zinc-500">
        Draft dismissed. It wasn&apos;t sent.
      </p>
    );
  }

  const badge = state === "sending" ? "SENDING" : invoice.status;

  return (
    <div className="w-full max-w-md overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Invoice{invoice.number ? ` #${invoice.number}` : ""}
          </p>
          <p className="truncate text-base font-semibold">{invoice.client}</p>
        </div>
        <StatusBadge status={badge} />
      </div>

      <ul className="divide-y divide-zinc-100 px-4 text-sm dark:divide-zinc-800">
        {invoice.items.map((it, i) => (
          <li key={i} className="flex items-start justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="break-words">{it.name}</p>
              {it.quantity !== 1 && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {it.quantity} × {money(it.unitAmount, invoice.currency)}
                </p>
              )}
            </div>
            <p className="shrink-0 tabular-nums">{money(it.quantity * it.unitAmount, invoice.currency)}</p>
          </li>
        ))}
      </ul>

      <div className="flex items-end justify-between gap-3 border-t border-zinc-100 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          Due
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {invoice.dueDate ? formatDate(invoice.dueDate) : "On receipt"}
          </p>
        </div>
        <div className="text-right text-xs text-zinc-500 dark:text-zinc-400">
          Total
          <p className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            {money(invoice.total, invoice.currency)}
          </p>
        </div>
      </div>

      {state === "sent" ? (
        <div className="flex items-center gap-2 border-t border-zinc-100 px-4 py-3 text-sm text-emerald-700 dark:border-zinc-800 dark:text-emerald-400">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" />
          </svg>
          Sent to {invoice.client} via PayPal.
        </div>
      ) : (
        <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
          {error && (
            <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onApprove}
              disabled={state === "sending"}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-60"
            >
              {state === "sending" && <Spinner />}
              {state === "sending" ? "Sending…" : "Approve & Send"}
            </button>
            <button
              type="button"
              onClick={onDiscard}
              disabled={state === "sending"}
              className="rounded-xl border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
