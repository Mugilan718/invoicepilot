"use client";

// Shared AG Grid setup for the dashboard: only the Community modules we use, plus a theme
// that matches the app and follows the OS light/dark preference (like the rest of the UI).

import { useEffect, type ReactNode } from "react";
import {
  CellStyleModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  CsvExportModule,
  DateFilterModule,
  ExternalFilterModule,
  NumberFilterModule,
  PaginationModule,
  PinnedRowModule,
  QuickFilterModule,
  RowApiModule,
  RowStyleModule,
  TextFilterModule,
  TooltipModule,
  ValidationModule,
  themeQuartz,
  type Module,
} from "ag-grid-community";
import { AgGridProvider } from "ag-grid-react";

/** Registering only what we use keeps the bundle small (vs. AllCommunityModule). */
const MODULES: Module[] = [
  ClientSideRowModelModule,
  ClientSideRowModelApiModule,
  RowApiModule,
  TextFilterModule,
  NumberFilterModule,
  DateFilterModule,
  QuickFilterModule,
  ExternalFilterModule,
  PaginationModule,
  PinnedRowModule,
  RowStyleModule,
  CellStyleModule,
  CsvExportModule,
  TooltipModule,
  // Dev-only: logs helpful warnings for misconfigured options or missing modules.
  ...(process.env.NODE_ENV !== "production" ? [ValidationModule] : []),
];

export function GridProvider({ children }: { children: ReactNode }) {
  return <AgGridProvider modules={MODULES}>{children}</AgGridProvider>;
}

/** Quartz, re-skinned with the app's zinc + indigo palette; "dark" mode values mirror Tailwind dark classes. */
export const gridTheme = themeQuartz
  .withParams({
    accentColor: "#4f46e5", // indigo-600
    backgroundColor: "#ffffff",
    foregroundColor: "#18181b", // zinc-900
    textColor: "#27272a",
    subtleTextColor: "#71717a", // zinc-500
    borderColor: "#e4e4e7", // zinc-200
    chromeBackgroundColor: "#fafafa", // zinc-50
    headerBackgroundColor: "#fafafa",
    headerTextColor: "#52525b", // zinc-600
    headerFontWeight: 600,
    headerFontSize: 12,
    rowHoverColor: "#f4f4f5", // zinc-100
    fontFamily: "inherit",
    fontSize: 13,
    wrapperBorderRadius: 16,
    borderRadius: 8,
    spacing: 7,
    browserColorScheme: "light",
  })
  .withParams(
    {
      accentColor: "#818cf8", // indigo-400
      backgroundColor: "#18181b", // zinc-900
      foregroundColor: "#f4f4f5",
      textColor: "#e4e4e7",
      subtleTextColor: "#a1a1aa", // zinc-400
      borderColor: "#27272a", // zinc-800
      chromeBackgroundColor: "#1c1c20",
      headerBackgroundColor: "#1c1c20",
      headerTextColor: "#a1a1aa",
      rowHoverColor: "#27272a",
      browserColorScheme: "dark",
    },
    "dark"
  );

/**
 * AG Grid theme modes are selected by a data attribute on <body>. Mirror the OS color scheme
 * (which the rest of the app follows via Tailwind's `dark:` media variant) and keep it in sync.
 */
export function useGridThemeMode() {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.body.dataset.agThemeMode = mq.matches ? "dark" : "light";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      delete document.body.dataset.agThemeMode;
    };
  }, []);
}

/** True when the viewport is narrower than Tailwind's `sm` breakpoint. */
export function subscribeNarrow(callback: () => void) {
  const mq = window.matchMedia("(max-width: 639px)");
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}
export const getNarrow = () => window.matchMedia("(max-width: 639px)").matches;
export const getNarrowServer = () => false;

// Formatting helpers shared by the dashboard components.
export const money = (n: number | null | undefined, currency = "USD", compact = false) =>
  n == null
    ? ""
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        ...(compact ? { maximumFractionDigits: 0 } : {}),
      }).format(n);

export const shortDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
};

/** Date filter comparator for YYYY-MM-DD strings (AG Grid passes the filter date at local midnight). */
export function compareIsoDate(filterDate: Date, cellValue: string | null): number {
  if (!cellValue) return -1;
  const [y, m, d] = cellValue.split("-").map(Number);
  const cell = new Date(y, m - 1, d).getTime();
  const filter = filterDate.getTime();
  return cell < filter ? -1 : cell > filter ? 1 : 0;
}
