// Simple in-memory, per-IP sliding-window rate limiter for the public demo.
// Good enough for a single server instance (Render free tier); a multi-instance deployment
// would need a shared store such as Redis.

const DEFAULT_LIMIT = 20;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
/** Safety cap on tracked keys, so the map can't grow without bound. */
const MAX_KEYS = 10_000;

/** key = `${bucket}:${ip}` -> request timestamps (ms) within the window, oldest first. */
const hits = new Map<string, number[]>();
let lastSweep = 0;

/**
 * Best-effort client IP. Prefer headers set by the hosting edge (Cloudflare/Render), which
 * clients can't spoof, over the client-controllable leftmost X-Forwarded-For entry.
 */
export function clientIp(request: Request): string {
  const h = request.headers;
  return (
    h.get("cf-connecting-ip")?.trim() ||
    h.get("true-client-ip")?.trim() ||
    h.get("x-real-ip")?.trim() ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/** Drops expired entries (at most once a minute) and enforces the key cap. */
function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000 && hits.size < MAX_KEYS) return;
  lastSweep = now;
  for (const [key, times] of hits) {
    if (!times.length || now - times[times.length - 1] >= windowMs) hits.delete(key);
  }
  // Still too many: evict the oldest-inserted keys (Map preserves insertion order).
  for (const key of hits.keys()) {
    if (hits.size <= MAX_KEYS) break;
    hits.delete(key);
  }
}

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
}

/**
 * Counts this request against `bucket` for the caller's IP. Returns a ready-to-send 429
 * response if the limit is exceeded, otherwise null.
 *
 *   const limited = rateLimit(request, "agent");
 *   if (limited) return limited;
 */
export function rateLimit(
  request: Request,
  bucket: string,
  { limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS }: RateLimitOptions = {}
): Response | null {
  const now = Date.now();
  sweep(now, windowMs);

  const key = `${bucket}:${clientIp(request)}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);

  if (recent.length >= limit) {
    hits.set(key, recent);
    const retryAfterSec = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
    const minutes = Math.ceil(retryAfterSec / 60);
    console.warn(`[rate-limit] ${bucket}: limit of ${limit} per ${windowMs / 60000} min reached`);
    return Response.json(
      {
        success: false,
        rateLimited: true,
        retryAfterSeconds: retryAfterSec,
        error:
          `You're going a little fast for this demo. Please try again in ` +
          `${minutes <= 1 ? "about a minute" : `about ${minutes} minutes`}. ` +
          `(Limit: ${limit} requests per ${Math.round(windowMs / 60000)} minutes.)`,
      },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  recent.push(now);
  hits.delete(key); // re-insert so insertion order tracks recency for eviction
  hits.set(key, recent);
  return null;
}
