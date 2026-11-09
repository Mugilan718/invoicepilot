import type { Metadata } from "next";
import Dashboard from "@/app/components/dashboard/Dashboard";

export const metadata: Metadata = {
  title: "Dashboard · InvoicePilot",
};

export default function DashboardPage() {
  return <Dashboard />;
}
