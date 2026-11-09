// "Today" for the app. DEMO_TODAY (YYYY-MM-DD) overrides the real date so seeded invoices
// can appear overdue in a demo. The UI shows a badge whenever it is active.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function localIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The DEMO_TODAY override, or null if unset or invalid. */
export function getDemoToday(): string | null {
  const raw = process.env.DEMO_TODAY?.trim();
  if (!raw) return null;
  if (!DATE_RE.test(raw) || Number.isNaN(Date.parse(raw))) {
    console.warn(`[demo-clock] Ignoring invalid DEMO_TODAY "${raw}" (expected YYYY-MM-DD).`);
    return null;
  }
  return raw;
}

/** Today's date as YYYY-MM-DD, honoring DEMO_TODAY. */
export function getToday(): string {
  return getDemoToday() ?? localIsoDate(new Date());
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). Positive if `to` is later. */
export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** Adds days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Weekday name for a YYYY-MM-DD date. */
export function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}
