import { connection } from "next/server";
import { listInvoices } from "@/lib/paypal";
import { getToday } from "@/lib/demo-clock";
import { withAging } from "@/lib/invoices";
import { AgentError } from "@/lib/gemini";
import { generateInsights } from "@/lib/insights";
import type { InsightsResponse } from "@/lib/types";

/** Generates 3-4 AI cash-flow insights from current invoice stats (one Gemini call). */
export async function POST() {
  await connection();
  const started = Date.now();
  try {
    const today = getToday();
    const invoices = (await listInvoices()).map((inv) => withAging(inv, today));
    if (invoices.length === 0) {
      return Response.json({ error: "There are no invoices to analyze yet." }, { status: 400 });
    }

    const { insights, model } = await generateInsights(invoices, today);
    if (insights.length === 0) {
      console.error(`[api/insights] 502 in ${Date.now() - started}ms: model returned no usable insights`);
      return Response.json({ error: "The AI didn't return usable insights. Please try again." }, { status: 502 });
    }

    const body: InsightsResponse = { insights, model, generatedAt: new Date().toISOString() };
    console.info(`[api/insights] 200 in ${Date.now() - started}ms`);
    return Response.json(body);
  } catch (err) {
    if (err instanceof AgentError) {
      console.error(`[api/insights] 502 in ${Date.now() - started}ms: ${err.message}`);
      return Response.json({ error: err.userMessage }, { status: 502 });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/insights] 500 in ${Date.now() - started}ms: ${message}`);
    return Response.json({ error: "Couldn't generate insights right now. Please try again." }, { status: 500 });
  }
}
