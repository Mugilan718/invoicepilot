// Gemini invoicing agent (chat → draft invoice). Server-side use only.

import type { Content, FunctionDeclaration, Part } from "@google/genai";
import { createDraftInvoice, type InvoiceItemInput } from "@/lib/paypal";
import { findClient, getClients } from "@/lib/clients";
import { getToday, weekdayOf } from "@/lib/demo-clock";
import { createCallContext, generateWithFallback, redact } from "@/lib/gemini";
import type { AgentResponse, ChatMessage, InvoiceSummary } from "@/lib/types";

export { AgentError } from "@/lib/gemini";

const MAX_TOOL_ROUNDS = 4;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const READY_REPLY = (inv: InvoiceSummary) =>
  `Done! I drafted an invoice for ${inv.client} totaling ${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: inv.currency,
  }).format(inv.total)}${inv.dueDate ? `, due ${inv.dueDate}` : ""}. ` +
  `It's still a draft. Review it below and click "Approve & Send" when you're happy with it.`;

// The client list lives in the system prompt, so the model never needs a lookup call.
const tools: FunctionDeclaration[] = [
  {
    name: "create_draft_invoice",
    description:
      "Create a DRAFT PayPal invoice for a saved client. This does NOT send it; the user must approve sending in the UI.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        client_name: {
          type: "string",
          description: "Exact client name from the saved client list in the instructions.",
        },
        items: {
          type: "array",
          minItems: 1,
          description: "Line items on the invoice.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Short description of the work, e.g. 'Logo design'." },
              quantity: { type: "number", description: "Quantity, usually 1. Hours if billed hourly." },
              unit_amount: { type: "number", description: "Price per unit in USD, e.g. 1200 or 85.5." },
            },
            required: ["name", "quantity", "unit_amount"],
          },
        },
        due_date: {
          type: "string",
          description: "Optional due date in YYYY-MM-DD format.",
        },
        note: {
          type: "string",
          description: "Optional short note to the client shown on the invoice.",
        },
      },
      required: ["client_name", "items"],
    },
  },
];

function systemPrompt(today: string, clientNames: string[]): string {
  return `You are InvoicePilot, a friendly invoicing assistant for freelancers.
Today's date is ${today} (${weekdayOf(today)}).

Saved clients (the only clients you can invoice): ${clientNames.join(", ")}.

What you can do:
- Create DRAFT PayPal invoices (USD) with create_draft_invoice.

Rules:
- When the request names a saved client and an amount, call create_draft_invoice right away. Don't ask for confirmation first; the user reviews the draft before anything is sent.
- Convert relative dates like "in 2 weeks", "next Friday" or "end of month" into YYYY-MM-DD based on today's date. Due dates cannot be in the past. If no due date is given, leave it out.
- If the client or the amount is missing or ambiguous, or the client is not in the saved list, ask ONE short clarifying question instead of guessing. Never invent amounts or clients.
- Create at most one invoice per user request.
- You can ONLY create drafts. You must NEVER say or imply that an invoice was sent, emailed or delivered.
- If a tool returns an error, explain it briefly in plain language and suggest a fix.
- Keep replies short, warm and clear. Plain text only, no markdown tables.`;
}

class ToolError extends Error {}

interface CreateArgs {
  client_name?: unknown;
  items?: unknown;
  due_date?: unknown;
  note?: unknown;
}

function parseItems(raw: unknown): InvoiceItemInput[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ToolError("At least one line item is required.");
  return raw.map((it, i) => {
    const obj = (it ?? {}) as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const quantity = Number(obj.quantity ?? 1);
    const unitAmount = Number(obj.unit_amount);
    if (!name) throw new ToolError(`Item ${i + 1} is missing a description.`);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new ToolError(`Item "${name}" has an invalid quantity.`);
    if (!Number.isFinite(unitAmount) || unitAmount <= 0) throw new ToolError(`Item "${name}" has an invalid amount.`);
    return { name, quantity, unitAmount: Math.round(unitAmount * 100) / 100 };
  });
}

async function runCreateDraftInvoice(args: CreateArgs, today: string): Promise<InvoiceSummary> {
  const clientName = typeof args.client_name === "string" ? args.client_name : "";
  const client = findClient(clientName);
  if (!client) {
    const names = getClients().map((c) => c.name).join(", ");
    throw new ToolError(`No saved client matches "${clientName}". Saved clients: ${names}.`);
  }

  const items = parseItems(args.items);

  let dueDate: string | undefined;
  if (typeof args.due_date === "string" && args.due_date.trim()) {
    dueDate = args.due_date.trim();
    if (!DATE_RE.test(dueDate) || Number.isNaN(Date.parse(dueDate))) {
      throw new ToolError(`Due date "${dueDate}" is not a valid YYYY-MM-DD date.`);
    }
    if (dueDate < today) throw new ToolError(`Due date ${dueDate} is in the past.`);
  }
  const note = typeof args.note === "string" && args.note.trim() ? args.note.trim() : undefined;

  const invoice = await createDraftInvoice({
    email: client.email,
    recipientName: client.name,
    items,
    dueDate,
    note,
  });

  const computedTotal = items.reduce((sum, it) => sum + it.quantity * it.unitAmount, 0);
  const paypalTotal = invoice.amount?.value ? Number(invoice.amount.value) : NaN;

  return {
    id: invoice.id,
    number: invoice.detail?.invoice_number ?? null,
    status: invoice.status,
    client: client.name,
    items,
    total: Number.isFinite(paypalTotal) ? paypalTotal : Math.round(computedTotal * 100) / 100,
    currency: "USD",
    dueDate: invoice.detail?.payment_term?.due_date ?? dueDate ?? null,
  };
}

export async function runAgent(messages: ChatMessage[]): Promise<AgentResponse> {
  const ctx = createCallContext();
  const today = getToday();
  const system = systemPrompt(today, getClients().map((c) => c.name));
  const finish = (result: AgentResponse, outcome: string): AgentResponse => {
    console.info(`[agent] ${outcome}: ${ctx.calls} Gemini call(s), ${Date.now() - ctx.startedAt}ms`);
    return result;
  };

  // Gemini history must start with a user turn.
  const firstUser = messages.findIndex((m) => m.role === "user");
  const contents: Content[] = messages.slice(Math.max(firstUser, 0)).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  let modelIndex = 0;
  let invoice: InvoiceSummary | undefined;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let result;
    try {
      result = await generateWithFallback(ctx, modelIndex, {
        contents,
        config: {
          systemInstruction: system,
          tools: [{ functionDeclarations: tools }],
        },
      });
    } catch (err) {
      // The draft already exists in PayPal; still show it rather than losing it.
      if (invoice) {
        console.error("[agent] model failed after draft was created:", err instanceof Error ? err.message : err);
        return finish({ reply: READY_REPLY(invoice), invoice }, "done (fallback reply)");
      }
      console.info(`[agent] failed: ${ctx.calls} Gemini call(s), ${Date.now() - ctx.startedAt}ms`);
      throw err;
    }

    const response = result.response;
    if (result.modelIndex !== modelIndex || round === 0) {
      console.info(`[agent] answered by ${ctx.models[result.modelIndex]} (round ${round + 1})`);
    }
    modelIndex = result.modelIndex;

    const calls = response.functionCalls ?? [];
    if (calls.length === 0) {
      const reply = response.text?.trim();
      return finish(
        {
          reply: reply || (invoice ? READY_REPLY(invoice) : "Sorry, I didn't catch that. Could you rephrase?"),
          invoice,
        },
        "done"
      );
    }

    // Echo the model's turn back unchanged (keeps thought signatures intact).
    const modelContent = response.candidates?.[0]?.content;
    contents.push(modelContent ?? { role: "model", parts: calls.map((fc) => ({ functionCall: fc })) });

    const responseParts: Part[] = [];
    let toolFailed = false;
    for (const call of calls) {
      let toolResult: Record<string, unknown>;
      const toolStarted = Date.now();
      try {
        if (call.name === "create_draft_invoice") {
          if (invoice) throw new ToolError("A draft invoice was already created for this request.");
          invoice = await runCreateDraftInvoice((call.args ?? {}) as CreateArgs, today);
          toolResult = { success: true, invoice };
        } else {
          throw new ToolError(`Unknown tool "${call.name}".`);
        }
        console.info(`[agent] tool ${call.name} ok ${Date.now() - toolStarted}ms`);
      } catch (err) {
        toolFailed = true;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[agent] tool ${call.name} failed ${Date.now() - toolStarted}ms: ${redact(msg)}`);
        toolResult = { error: msg };
      }
      responseParts.push({ functionResponse: { id: call.id, name: call.name, response: toolResult } });
    }

    // Happy path: the draft was created and nothing failed. The reply is predictable, so
    // skip a second Gemini round-trip and answer directly.
    if (invoice && !toolFailed) {
      return finish({ reply: READY_REPLY(invoice), invoice }, "done");
    }

    // Something failed: let the model explain it / ask a question.
    contents.push({ role: "user", parts: responseParts });
  }

  return finish(
    {
      reply: invoice ? READY_REPLY(invoice) : "Sorry, I got stuck working on that. Could you try rephrasing?",
      invoice,
    },
    "done (max rounds)"
  );
}
