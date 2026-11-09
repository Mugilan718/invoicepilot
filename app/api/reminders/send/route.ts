import { connection } from "next/server";
import { getInvoice, normalizeInvoice, remindInvoice } from "@/lib/paypal";
import { withAging } from "@/lib/invoices";
import { MAX_NOTE_CHARS, MAX_SUBJECT_CHARS } from "@/lib/reminders";

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Sends a payment reminder. Body: { id, subject, note }. Only allowed for overdue invoices. */
export async function POST(request: Request) {
  await connection();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ success: false, error: "Request body must be JSON." }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";

  if (!ID_RE.test(id)) {
    return Response.json({ success: false, error: "Invalid invoice id." }, { status: 400 });
  }
  if (!note) {
    return Response.json({ success: false, error: "The reminder note can't be empty." }, { status: 400 });
  }
  if (note.length > MAX_NOTE_CHARS || subject.length > MAX_SUBJECT_CHARS) {
    return Response.json(
      { success: false, error: `Keep the subject under ${MAX_SUBJECT_CHARS} and the note under ${MAX_NOTE_CHARS} characters.` },
      { status: 400 }
    );
  }

  try {
    const invoice = withAging(normalizeInvoice(await getInvoice(id)));
    if (!invoice.overdue) {
      return Response.json(
        { success: false, error: `This invoice isn't overdue (status ${invoice.status}), so no reminder was sent.` },
        { status: 409 }
      );
    }

    await remindInvoice(id, { subject: subject || `Reminder: invoice #${invoice.number ?? id}`, note });
    const sentAt = new Date().toISOString();
    console.info(`[api/reminders/send] reminder sent for ${id} (${invoice.daysOverdue} days overdue)`);
    return Response.json({ success: true, id, sentAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/reminders/send]", message);
    return Response.json(
      { success: false, error: "PayPal couldn't send this reminder. Please try again.", detail: message },
      { status: 502 }
    );
  }
}
