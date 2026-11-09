// Shared Gemini call plumbing: per-call timeout, retries, model fallback, request time budget,
// minimal thinking and timing logs. Server-side use only (reads GEMINI_API_KEY).

import { ApiError, GoogleGenAI, ThinkingLevel, type ThinkingConfig } from "@google/genai";

const DEFAULT_MODEL = "gemini-3.8-flash";
/** Hard timeout for a single Gemini HTTP call. */
const CALL_TIMEOUT_MS = 12_000;
/** Retries per model after the first attempt, then move to the next model. */
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 1000;
/** Default total time budget for one request (all models, retries and tools). */
export const DEFAULT_BUDGET_MS = 30_000;
/** Don't start a Gemini call with less time than this left in the budget. */
const MIN_CALL_MS = 2000;
/** Transient statuses worth retrying (overloaded, rate limited, upstream hiccups). */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** An AI failure with a message that is safe to show to the user. */
export class AgentError extends Error {
  userMessage: string;
  constructor(message: string, userMessage: string) {
    super(message);
    this.userMessage = userMessage;
  }
}

/** Removes the API key from any text, in case an upstream error ever echoes it. */
export function redact(text: string): string {
  const key = process.env.GEMINI_API_KEY;
  return key ? text.split(key).join("[redacted]") : text;
}

/** Primary model first, then GEMINI_FALLBACK_MODELS in order, without duplicates. */
function getModelChain(): string[] {
  const primary = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set([primary, ...fallbacks])];
}

/**
 * Lowest thinking setting per model generation:
 * Gemini 2.x takes a token budget (0 = off for Flash / Flash-Lite);
 * Gemini 3+ takes a thinking level (MINIMAL is the lowest).
 */
function thinkingConfigFor(model: string): ThinkingConfig {
  const name = model.replace(/^models\//, "");
  return /^gemini-(1|2)\./.test(name)
    ? { thinkingBudget: 0 }
    : { thinkingLevel: ThinkingLevel.MINIMAL };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class TimeoutError extends Error {}

function errorStatus(err: unknown): number | undefined {
  return err instanceof ApiError ? err.status : undefined;
}

/** 429/5xx, timeouts, or any non-HTTP failure (network error). */
function isRetryable(err: unknown): boolean {
  const status = errorStatus(err);
  return status === undefined || RETRYABLE_STATUSES.has(status);
}

function shortError(err: unknown): string {
  if (err instanceof TimeoutError) return err.message;
  const msg = redact(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ");
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
}

function friendlyMessage(err: unknown, models: string[]): string {
  const status = errorStatus(err);
  if (status === 429) {
    return "The AI is getting too many requests right now (free-tier limit). Please wait a minute and try again.";
  }
  if (status === 401 || status === 403) {
    return "The AI request was rejected. Check GEMINI_API_KEY in .env.local.";
  }
  if (status === 400 || status === 404) {
    return `The Gemini request failed for ${models.join(", ")}. Check GEMINI_MODEL and GEMINI_FALLBACK_MODELS in .env.local.`;
  }
  return "The AI assistant is unavailable right now (high demand). Please try again in a moment.";
}

export type GenerateParams = Parameters<GoogleGenAI["models"]["generateContent"]>[0];
export type GenerateResult = Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>;
type GenerateConfig = NonNullable<GenerateParams["config"]>;

export interface CallContext {
  ai: GoogleGenAI;
  models: string[];
  /** Epoch ms after which no new Gemini call is started. */
  deadline: number;
  /** Counts every Gemini HTTP call made for this request. */
  calls: number;
  startedAt: number;
}

/** Creates the per-request context. Throws AgentError if GEMINI_API_KEY is missing. */
export function createCallContext(budgetMs: number = DEFAULT_BUDGET_MS): CallContext {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your_gemini_key") {
    throw new AgentError("GEMINI_API_KEY is not set.", "The AI assistant isn't configured yet (missing GEMINI_API_KEY).");
  }
  const startedAt = Date.now();
  return {
    ai: new GoogleGenAI({ apiKey }),
    models: getModelChain(),
    deadline: startedAt + budgetMs,
    calls: 0,
    startedAt,
  };
}

/** One Gemini call with a hard timeout (12s, or less if the request budget is nearly spent). */
async function timedCall(ctx: CallContext, params: GenerateParams, attemptLabel: string): Promise<GenerateResult> {
  const timeoutMs = Math.min(CALL_TIMEOUT_MS, ctx.deadline - Date.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  ctx.calls++;
  try {
    const response = await ctx.ai.models.generateContent({
      ...params,
      config: { ...params.config, abortSignal: controller.signal },
    });
    console.info(`[gemini] ok   model=${params.model} attempt=${attemptLabel} ${Date.now() - started}ms`);
    return response;
  } catch (err) {
    const error = controller.signal.aborted ? new TimeoutError(`timed out after ${timeoutMs}ms`) : err;
    const status = errorStatus(error);
    console.warn(
      `[gemini] fail model=${params.model} attempt=${attemptLabel} ${Date.now() - started}ms` +
        ` (${status ?? (error instanceof TimeoutError ? "timeout" : "network")}): ${shortError(error)}`
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls Gemini with one retry per model, then falls back to the next model, all within the
 * request's time budget. Only the model call is retried; callers run tools after a successful
 * response, so a retry can never repeat a tool call (e.g. create a duplicate invoice).
 *
 * `startIndex` lets a multi-round caller stay on the model that already answered.
 */
export async function generateWithFallback(
  ctx: CallContext,
  startIndex: number,
  params: Omit<GenerateParams, "model">
): Promise<{ response: GenerateResult; modelIndex: number }> {
  const { models } = ctx;
  let lastError: unknown = new TimeoutError("request time budget exhausted");

  for (let i = startIndex; i < models.length; i++) {
    const model = models[i];
    let config: GenerateConfig = { ...params.config, thinkingConfig: thinkingConfigFor(model) };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (ctx.deadline - Date.now() < MIN_CALL_MS) {
        throw new AgentError(
          `Request time budget exhausted after ${ctx.calls} Gemini calls: ${shortError(lastError)}`,
          friendlyMessage(lastError, models)
        );
      }
      try {
        const response = await timedCall(ctx, { ...params, model, config }, `${attempt + 1}/${MAX_RETRIES + 1}`);
        return { response, modelIndex: i };
      } catch (err) {
        lastError = err;
        const status = errorStatus(err);

        // Auth problems affect every model; fail fast.
        if (status === 401 || status === 403) {
          throw new AgentError(`Gemini auth failed (${status}): ${shortError(err)}`, friendlyMessage(err, models));
        }
        // A model that rejects the thinking setting: retry once without it.
        if (status === 400 && config.thinkingConfig && /thinking/i.test(shortError(err))) {
          console.warn(`[gemini] ${model} rejected thinkingConfig; retrying without it`);
          config = { ...params.config, thinkingConfig: undefined };
          continue;
        }
        if (!isRetryable(err) || attempt >= MAX_RETRIES) break; // move on to the next model
        if (ctx.deadline - Date.now() < RETRY_DELAY_MS + MIN_CALL_MS) break;
        await sleep(RETRY_DELAY_MS);
      }
    }
    if (i + 1 < models.length) console.warn(`[gemini] ${model} gave up; falling back to ${models[i + 1]}`);
  }

  throw new AgentError(
    `All Gemini models failed (${models.slice(startIndex).join(", ")}): ${shortError(lastError)}`,
    friendlyMessage(lastError, models)
  );
}
