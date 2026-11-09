"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Create" },
  { href: "/follow-ups", label: "Follow-ups" },
  { href: "/dashboard", label: "Dashboard" },
];

function prettyDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function AppHeader({ demoToday }: { demoToday: string | null }) {
  const pathname = usePathname();

  return (
    <header className="shrink-0 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 pt-3 pb-2 sm:pb-3">
        <Link href="/" className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5M9 13h6M9 17h4" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-base font-semibold leading-tight tracking-tight">InvoicePilot</p>
            <p className="hidden truncate text-xs text-zinc-500 sm:block dark:text-zinc-400">
              Invoices from plain language. Follow-ups on autopilot.
            </p>
          </div>
        </Link>

        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {demoToday && (
            <span
              title="DEMO_TODAY is set: overdue days are calculated from this date instead of the real date."
              className="rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300"
            >
              Demo date: {prettyDate(demoToday)}
            </span>
          )}
          <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
            Sandbox
          </span>
        </div>
      </div>

      <nav className="mx-auto flex max-w-6xl gap-1 px-4 pb-2" aria-label="Main">
        {TABS.map((tab) => {
          const active = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                  : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
