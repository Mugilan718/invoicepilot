import { connection } from "next/server";
import { listInvoices } from "@/lib/paypal";
import { getDemoToday, getToday } from "@/lib/demo-clock";
import { withAging } from "@/lib/invoices";
import type { InvoicesResponse } from "@/lib/types";

export async function GET() {
  await connection();
  const started = Date.now();
  try {
    const today = getToday();
    const invoices = (await listInvoices()).map((inv) => withAging(inv, today));
    const body: InvoicesResponse = { today, demo: getDemoToday() !== null, invoices };
    console.info(`[api/invoices] ${invoices.length} invoice(s) in ${Date.now() - started}ms`);
    return Response.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/invoices]", message);
    return Response.json(
      { error: "Couldn't load invoices from PayPal. Please try again.", detail: message },
      { status: 502 }
    );
  }
}
