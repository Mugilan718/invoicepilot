import { connection } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { listInvoices } from "@/lib/paypal";
import { getToday } from "@/lib/demo-clock";
import { withAging } from "@/lib/invoices";
import { AgentError } from "@/lib/gemini";
import { draftReminders } from "@/lib/reminders";

/** Drafts reminders for overdue invoices. Optional body: { ids: string[] } to limit which ones. */
export async function POST(request: Request) {
  await connection();
  const limited = rateLimit(request, "reminders-draft");
  if (limited) return limited;
  const started = Date.now();

  let ids: Set<string> | null = null;
  try {
    const body = (await request.json()) as { ids?: unknown };
    if (Array.isArray(body?.ids)) ids = new Set(body.ids.filter((x): x is string => typeof x === "string"));
  } catch {
    // No/invalid body: draft for every overdue invoice.
  }

  try {
    const today = getToday();
    const overdue = (await listInvoices())
      .map((inv) => withAging(inv, today))
      .filter((inv) => inv.overdue && (!ids || ids.has(inv.id)));

    const reminders = await draftReminders(overdue);
    console.info(`[api/reminders/draft] 200 in ${Date.now() - started}ms (${reminders.length} reminder(s))`);
    return Response.json({ reminders });
  } catch (err) {
    if (err instanceof AgentError) {
      console.error(`[api/reminders/draft] 502 in ${Date.now() - started}ms: ${err.message}`);
      return Response.json({ error: err.userMessage }, { status: 502 });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/reminders/draft] 500 in ${Date.now() - started}ms: ${message}`);
    return Response.json({ error: "Couldn't draft reminders right now. Please try again." }, { status: 500 });
  }
}
