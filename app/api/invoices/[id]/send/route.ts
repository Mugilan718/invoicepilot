import { connection } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getInvoice, sendInvoice } from "@/lib/paypal";

export async function POST(request: Request, ctx: RouteContext<"/api/invoices/[id]/send">) {
  await connection();
  const limited = rateLimit(request, "invoice-send");
  if (limited) return limited;
  const { id } = await ctx.params;

  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) {
    return Response.json({ success: false, error: "Invalid invoice id." }, { status: 400 });
  }

  try {
    await sendInvoice(id);
    const invoice = await getInvoice(id);
    return Response.json({ success: true, id: invoice.id, status: invoice.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/invoices/send]", message);
    return Response.json(
      { success: false, error: "PayPal couldn't send this invoice. Please try again.", detail: message },
      { status: 502 }
    );
  }
}
