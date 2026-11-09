// AI cash-flow insights: one Gemini call over stats computed in code. Server-side only.
// Only aggregated numbers and client names are sent: no emails or other PII.

import { createCallContext, generateWithFallback } from "@/lib/gemini";
import { computeClientStats, computeKpis, clientOf, daysPaidLate, PAID_STATUSES } from "@/lib/stats";
import type { Insight, InvoiceWithAging } from "@/lib/types";

const MAX_INSIGHTS = 4;

const SYSTEM = `You are a cash-flow advisor for a freelancer. You get pre-computed invoice statistics as JSON.
Write ${MAX_INSIGHTS - 1} to ${MAX_INSIGHTS} short, specific, actionable insights, most important first.

Rules:
- Use ONLY the numbers and names in the data. Never invent clients, amounts, dates or history.
- Be specific: name the client, the amount (USD, e.g. "$2,400") and days overdue or late where relevant.
- Each insight should suggest a concrete next step (e.g. send a firm reminder today, ask for a deposit,
  shorten payment terms, send pending drafts, thank a reliable client).
- Don't repeat the same point twice. Cover different topics where the data allows
  (most urgent overdue invoice, a client's payment pattern, cash coming in, drafts not yet sent).
- Keep "title" under 70 characters and "detail" under 200 characters. Plain text, no markdown.
- priority: "high" for overdue money needing action now, "medium" for patterns worth acting on, "low" for positive or informational notes.
- "client" is the exact client name the insight is about; leave it out if it's about the whole business.

Return JSON only.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    insights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          client: { type: "string", description: "Client name; omit for business-wide insights." },
        },
        required: ["title", "detail", "priority"],
      },
    },
  },
  required: ["insights"],
};

/** Compact, PII-free summary for the model. */
function buildPayload(invoices: InvoiceWithAging[], today: string) {
  const kpis = computeKpis(invoices, today);
  const clients = computeClientStats(invoices).map((c) => ({
    client: c.client,
    totalBilled: c.totalBilled,
    outstanding: c.outstanding,
    paidOnTime: c.paidOnTimeCount,
    paidLate: c.paidLateCount,
    currentlyOverdue: c.overdueCount,
    avgDaysLate: c.avgDaysLate,
    maxDaysLate: c.maxDaysLate,
    reliability: c.reliability,
  }));
  const overdueInvoices = invoices
    .filter((i) => i.overdue)
    .sort((a, b) => b.daysOverdue - a.daysOverdue)
    .slice(0, 15)
    .map((i) => ({ number: i.number, client: clientOf(i), amountDue: i.amountDue, dueDate: i.dueDate, daysOverdue: i.daysOverdue }));
  const upcoming = invoices
    .filter((i) => !i.overdue && i.status === "SENT")
    .slice(0, 10)
    .map((i) => ({ number: i.number, client: clientOf(i), amountDue: i.amountDue, dueDate: i.dueDate }));
  const recentLatePayments = invoices
    .filter((i) => PAID_STATUSES.has(i.status) && daysPaidLate(i) > 0)
    .slice(0, 10)
    .map((i) => ({ number: i.number, client: clientOf(i), amount: i.total, daysLate: daysPaidLate(i), paidDate: i.paidDate }));

  return { today, kpis, clients, overdueInvoices, upcoming, recentLatePayments };
}

function parseInsights(text: string | undefined, knownClients: Set<string>): Insight[] {
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn("[insights] model returned invalid JSON");
    return [];
  }
  const list = (data as { insights?: unknown })?.insights;
  if (!Array.isArray(list)) return [];
  const out: Insight[] = [];
  for (const raw of list) {
    const { title, detail, priority, client } = (raw ?? {}) as Record<string, unknown>;
    if (typeof title !== "string" || typeof detail !== "string" || !title.trim() || !detail.trim()) continue;
    out.push({
      title: title.trim().slice(0, 120),
      detail: detail.trim().slice(0, 400),
      priority: priority === "high" || priority === "medium" || priority === "low" ? priority : "medium",
      // Only keep client names that actually exist in the data.
      client: typeof client === "string" && knownClients.has(client) ? client : null,
    });
    if (out.length === MAX_INSIGHTS) break;
  }
  return out;
}

export async function generateInsights(
  invoices: InvoiceWithAging[],
  today: string
): Promise<{ insights: Insight[]; model: string }> {
  // Strip emails so they can never reach the model (clientOf() falls back to the email
  // for invoices without a business name, e.g. drafts created before names were stored).
  const anonymized = invoices.map((i) => ({
    ...i,
    recipientEmail: null,
    recipientName: i.recipientName ?? "Unnamed client",
  }));
  const payload = buildPayload(anonymized, today);
  const ctx = createCallContext();
  const { response, modelIndex } = await generateWithFallback(ctx, 0, {
    contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_SCHEMA,
    },
  });
  const model = ctx.models[modelIndex];
  const insights = parseInsights(response.text, new Set(payload.clients.map((c) => c.client)));
  console.info(
    `[insights] ${insights.length} insight(s) from ${model}: ${ctx.calls} Gemini call(s), ${Date.now() - ctx.startedAt}ms`
  );
  return { insights, model };
}
