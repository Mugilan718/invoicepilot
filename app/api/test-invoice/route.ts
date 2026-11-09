import { connection } from "next/server";
import { createDraftInvoice } from "@/lib/paypal";

export async function GET() {
  // Always run at request time; never prerender (that would create invoices at build).
  await connection();

  try {
    const email = process.env.PAYPAL_TEST_CUSTOMER_EMAIL;
    if (!email) {
      throw new Error(
        "Missing PAYPAL_TEST_CUSTOMER_EMAIL. Set it in .env.local and restart the dev server."
      );
    }

    const invoice = await createDraftInvoice({
      email,
      itemName: "Logo design",
      amount: 1200,
    });

    return Response.json({
      success: true,
      id: invoice.id,
      status: invoice.status,
      number: invoice.detail?.invoice_number ?? null,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[test-invoice]", error);
    return Response.json({ success: false, error }, { status: 500 });
  }
}
