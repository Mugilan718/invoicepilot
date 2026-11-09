// Types shared between server code and the browser. Keep this file free of server-only imports.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface InvoiceItemSummary {
  name: string;
  quantity: number;
  unitAmount: number;
}

export interface InvoiceSummary {
  id: string;
  number: string | null;
  status: string;
  client: string;
  items: InvoiceItemSummary[];
  total: number;
  currency: string;
  dueDate: string | null;
}

/** A PayPal invoice flattened to the fields the app uses. */
export interface InvoiceRecord {
  id: string;
  number: string | null;
  status: string;
  /** Business name (demo client) or person name; null if PayPal has neither. */
  recipientName: string | null;
  recipientEmail: string | null;
  total: number;
  amountDue: number;
  amountPaid: number;
  currency: string;
  /** YYYY-MM-DD */
  dueDate: string | null;
  /** YYYY-MM-DD */
  invoiceDate: string | null;
  /** YYYY-MM-DD of the most recent payment, if any. */
  paidDate: string | null;
}

/** Reminder tone, by days overdue: 1-7 friendly, 8-30 firm, 31+ final. */
export type ReminderTier = "friendly" | "firm" | "final";

export interface InvoiceWithAging extends InvoiceRecord {
  overdue: boolean;
  /** Days past the due date (0 if not overdue). */
  daysOverdue: number;
  tier: ReminderTier | null;
}

export interface InvoicesResponse {
  /** The date used for overdue math (YYYY-MM-DD). */
  today: string;
  /** True when DEMO_TODAY overrides the real date. */
  demo: boolean;
  invoices: InvoiceWithAging[];
}

export interface ReminderDraft {
  id: string;
  subject: string;
  note: string;
  /** False when the AI skipped this invoice and a template was used instead. */
  aiDrafted: boolean;
}

export interface Insight {
  title: string;
  detail: string;
  priority: "high" | "medium" | "low";
  /** The client this insight is about, or null for business-wide insights. */
  client: string | null;
}

export interface InsightsResponse {
  insights: Insight[];
  model: string;
  generatedAt: string;
}

export interface AgentResponse {
  reply: string;
  invoice?: InvoiceSummary;
}
