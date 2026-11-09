import { connection } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { AgentError, runAgent } from "@/lib/agent";
import type { ChatMessage } from "@/lib/types";

const MAX_MESSAGES = 40;
const MAX_CHARS = 4000;

function parseMessages(body: unknown): ChatMessage[] | null {
  const raw = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const messages: ChatMessage[] = [];
  for (const m of raw.slice(-MAX_MESSAGES)) {
    const { role, content } = (m ?? {}) as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    messages.push({ role, content: content.slice(0, MAX_CHARS) });
  }
  return messages.some((m) => m.role === "user") ? messages : null;
}

export async function POST(request: Request) {
  await connection();
  const limited = rateLimit(request, "agent");
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const messages = parseMessages(body);
  if (!messages) {
    return Response.json(
      { error: "Expected { messages: [{ role: 'user' | 'assistant', content: string }] }." },
      { status: 400 }
    );
  }

  const started = Date.now();
  const elapsed = () => `${Date.now() - started}ms`;
  try {
    const result = await runAgent(messages);
    console.info(`[api/agent] 200 in ${elapsed()}${result.invoice ? ` (draft ${result.invoice.id})` : ""}`);
    return Response.json(result);
  } catch (err) {
    if (err instanceof AgentError) {
      console.error(`[api/agent] 502 in ${elapsed()}: ${err.message}`);
      return Response.json({ error: err.userMessage }, { status: 502 });
    }
    console.error(`[api/agent] 500 in ${elapsed()}:`, err instanceof Error ? err.message : err);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
