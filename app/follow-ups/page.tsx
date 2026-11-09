import type { Metadata } from "next";
import FollowUps from "@/app/components/FollowUps";

export const metadata: Metadata = {
  title: "Follow-ups · InvoicePilot",
};

export default function FollowUpsPage() {
  return <FollowUps />;
}
