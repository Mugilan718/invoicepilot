// AI drafting of payment reminders: one Gemini call for all overdue invoices.

import { addDays, getToday } from "@/lib/demo-clock";
import { createCallContext, generateWithFallback } from "@/lib/gemini";
import type { InvoiceWithAging, ReminderDraft, ReminderTier } from "@/lib/types";

export const MAX_SUBJECT_CHARS = 150;
export const MAX_NOTE_CHARS = 1200;
/** Days from today given as the "please pay by" date for 30+ day overdue invoices. */
const FINAL_PAY_BY_DAYS = 7;

const TONE: Record<ReminderTier, string> = {
  friendly: "friendly and casual: a light nudge, assume it slipped through the cracks",
  firm: "polite but firm: clearly state the invoice is overdue and ask for payment soon",
  final:
    "firm and professional: state how long it is overdue and clearly request payment by the given pay-by date; " +
    "offer to help if there is an issue",
};

const money = (n: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);

/** "2026-03-04" -> "March 4, 2026" */
export function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

interface ReminderFacts {
  id: string;
  client: string;
  invoiceNumber: string;
  amount: string;
  dueDate: string;
  daysOverdue: number;
  tone: ReminderTier;
  payBy?: string;
}

function factsFor(inv: InvoiceWithAging, today: string): ReminderFacts {
  const tone = inv.tier ?? "friendly";
  return {
    id: inv.id,
    client: inv.recipientName ?? "there",
    invoiceNumber: inv.number ?? inv.id,
    amount: money(inv.amountDue, inv.currency),
    dueDate: inv.dueDate ? prettyDate(inv.dueDate) : "the due date",
    daysOverdue: inv.daysOverdue,
    tone,
    ...(tone === "final" ? { payBy: prettyDate(addDays(today, FINAL_PAY_BY_DAYS)) } : {}),
  };
}

/** Plain template used when the AI leaves an invoice out or returns unusable output. */
function templateReminder(f: ReminderFacts): ReminderDraft {
  const subject =
    f.tone === "friendly"
      ? `Friendly reminder: invoice #${f.invoiceNumber}`
      : f.tone === "firm"
        ? `Overdue: invoice #${f.invoiceNumber} (${f.amount})`
        : `Payment request: invoice #${f.invoiceNumber} is ${f.daysOverdue} days overdue`;
  const note =
    f.tone === "friendly"
      ? `Hi ${f.client},\n\nJust a quick reminder that invoice #${f.invoiceNumber} for ${f.amount} was due on ${f.dueDate}. ` +
        `If you've already sent it, thank you, and please ignore this note!\n\nThanks so much`
      : f.tone === "firm"
        ? `Hi ${f.client},\n\nInvoice #${f.invoiceNumber} for ${f.amount} was due on ${f.dueDate} and is now ${f.daysOverdue} days overdue. ` +
          `Could you please arrange payment at your earliest convenience? Let me know if anything is holding it up.\n\nThank you`
        : `Hello ${f.client},\n\nInvoice #${f.invoiceNumber} for ${f.amount}, originally due on ${f.dueDate}, is now ${f.daysOverdue} days overdue. ` +
          `Please arrange payment by ${f.payBy}. If there is an issue with the invoice, please reply so we can resolve it.\n\nThank you`;
  return { id: f.id, subject, note, aiDrafted: false };
}

const SYSTEM = `You write short payment reminder messages on behalf of a freelancer.
They are sent through PayPal's "remind" feature, so they are plain text (no markdown, no HTML).

For each invoice you are given, write a subject line and a short note (60-110 words).
Tone rules, by the "tone" field:
- friendly: ${TONE.friendly}
- firm: ${TONE.firm}
- final: ${TONE.final}

Every note must:
- Greet the client by name.
- Mention the invoice number, the amount, and the original due date exactly as given.
- For tone "final", ask for payment by the "payBy" date exactly as given.
- Stay courteous. Never threaten, never mention late fees, legal action, collections or credit reporting.
- Not invent facts (no fake payment links, account numbers or details not provided).
- End with a short sign-off like "Thank you" with no name and no placeholders such as [Your Name].

Return JSON only, with one entry per invoice id you were given.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reminders: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          subject: { type: "string" },
          note: { type: "string" },
        },
        required: ["id", "subject", "note"],
      },
    },
  },
  required: ["reminders"],
};

function parseModelOutput(text: string | undefined): Map<string, { subject: string; note: string }> {
  const out = new Map<string, { subject: string; note: string }>();
  if (!text) return out;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn("[reminders] model returned invalid JSON; using templates");
    return out;
  }
  const list = (data as { reminders?: unknown })?.reminders;
  if (!Array.isArray(list)) return out;
  for (const r of list) {
    const { id, subject, note } = (r ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || typeof subject !== "string" || typeof note !== "string") continue;
    if (!subject.trim() || !note.trim()) continue;
    out.set(id, {
      subject: subject.trim().slice(0, MAX_SUBJECT_CHARS),
      note: note.trim().slice(0, MAX_NOTE_CHARS),
    });
  }
  return out;
}

/** Drafts one reminder per overdue invoice using a single Gemini call. */
export async function draftReminders(overdue: InvoiceWithAging[]): Promise<ReminderDraft[]> {
  if (overdue.length === 0) return [];
  const today = getToday();
  const facts = overdue.map((inv) => factsFor(inv, today));

  const ctx = createCallContext();
  const { response, modelIndex } = await generateWithFallback(ctx, 0, {
    contents: [
      {
        role: "user",
        parts: [{ text: `Today is ${prettyDate(today)}.\nInvoices:\n${JSON.stringify(facts, null, 2)}` }],
      },
    ],
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_SCHEMA,
    },
  });

  const drafted = parseModelOutput(response.text);
  const reminders = facts.map((f) => {
    const ai = drafted.get(f.id);
    return ai ? { id: f.id, ...ai, aiDrafted: true } : templateReminder(f);
  });
  const missing = reminders.filter((r) => !r.aiDrafted).length;
  console.info(
    `[reminders] drafted ${reminders.length} reminder(s) with ${ctx.models[modelIndex]}` +
      `${missing ? ` (${missing} from template)` : ""}: ${ctx.calls} Gemini call(s), ${Date.now() - ctx.startedAt}ms`
  );
  return reminders;
}
