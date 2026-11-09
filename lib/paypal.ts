// PayPal Invoicing API v2 client (sandbox only). Server-side use only.
// Note: also run directly by Node (scripts/seed.ts), so keep runtime imports out of this file
// (type-only imports are fine; they are erased).

import type { InvoiceRecord } from "@/lib/types";

const PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com";

/** A failed PayPal API call, with the HTTP status and PayPal's error body. */
export class PayPalError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "PayPalError";
    this.status = status;
    this.body = body;
  }
}

export interface InvoiceItemInput {
  name: string;
  quantity: number;
  /** Price per unit in USD. */
  unitAmount: number;
}

interface CreateDraftInvoiceBase {
  email: string;
  /** Shown as the recipient's business name (also how we tell demo clients apart). */
  recipientName?: string;
  note?: string;
  /** YYYY-MM-DD */
  dueDate?: string;
  /** YYYY-MM-DD; defaults to today on PayPal's side. */
  invoiceDate?: string;
}

/** Either a list of items, or the legacy single-item shorthand. */
export type CreateDraftInvoiceInput = CreateDraftInvoiceBase &
  (
    | { items: InvoiceItemInput[]; itemName?: never; amount?: never }
    | { itemName: string; amount: number; items?: never }
  );

interface Money {
  currency_code: string;
  value: string;
}

export interface PayPalInvoice {
  id: string;
  status: string;
  detail: {
    invoice_number?: string;
    invoice_date?: string;
    currency_code: string;
    note?: string;
    payment_term?: { term_type?: string; due_date?: string };
    [key: string]: unknown;
  };
  primary_recipients?: {
    billing_info?: {
      business_name?: string;
      email_address?: string;
      name?: { given_name?: string; surname?: string; full_name?: string };
    };
  }[];
  amount?: Money;
  due_amount?: Money;
  [key: string]: unknown;
}

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET. Set them in .env.local and restart the dev server."
    );
  }
  return { clientId, clientSecret };
}

/** Reads the response body (JSON if possible, else text) for error messages. */
async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text();
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text || "(empty response body)";
  }
}

export async function getAccessToken(): Promise<string> {
  const { clientId, clientSecret } = getCredentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(
      `PayPal auth failed (${res.status} ${res.statusText}): ${await readErrorBody(res)}`
    );
  }

  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("PayPal auth response did not include an access_token.");
  }
  return data.access_token;
}

/** Authenticated request to the PayPal API. Throws with PayPal's error body on failure. */
async function paypalRequest(
  path: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: unknown; headers?: Record<string, string> },
  label: string
): Promise<Response> {
  const accessToken = await getAccessToken();
  const res = await fetch(`${PAYPAL_BASE_URL}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new PayPalError(
      `PayPal ${label} failed (${res.status} ${res.statusText}): ${body}`,
      res.status,
      body
    );
  }
  return res;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function createDraftInvoice(input: CreateDraftInvoiceInput): Promise<PayPalInvoice> {
  const { email, recipientName, note, dueDate, invoiceDate } = input;
  const items: InvoiceItemInput[] = input.items
    ? input.items
    : [{ name: input.itemName, quantity: 1, unitAmount: input.amount }];

  if (!email) throw new Error("createDraftInvoice: recipient email is required.");
  if (items.length === 0) throw new Error("createDraftInvoice: at least one item is required.");
  for (const item of items) {
    if (!item.name?.trim()) throw new Error("createDraftInvoice: every item needs a name.");
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw new Error(`createDraftInvoice: invalid quantity for "${item.name}" (${item.quantity}).`);
    }
    if (!Number.isFinite(item.unitAmount) || item.unitAmount <= 0) {
      throw new Error(`createDraftInvoice: invalid amount for "${item.name}" (${item.unitAmount}).`);
    }
  }
  if (dueDate !== undefined && !DATE_RE.test(dueDate)) {
    throw new Error(`createDraftInvoice: dueDate must be YYYY-MM-DD (got "${dueDate}").`);
  }
  if (invoiceDate !== undefined && !DATE_RE.test(invoiceDate)) {
    throw new Error(`createDraftInvoice: invoiceDate must be YYYY-MM-DD (got "${invoiceDate}").`);
  }

  const body = {
    detail: {
      currency_code: "USD",
      ...(invoiceDate ? { invoice_date: invoiceDate } : {}),
      ...(note ? { note } : {}),
      ...(dueDate
        ? { payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: dueDate } }
        : {}),
    },
    primary_recipients: [
      {
        billing_info: {
          email_address: email,
          ...(recipientName ? { business_name: recipientName } : {}),
        },
      },
    ],
    items: items.map((item) => ({
      name: item.name.trim(),
      quantity: String(item.quantity),
      unit_amount: { currency_code: "USD", value: item.unitAmount.toFixed(2) },
    })),
  };

  const res = await paypalRequest(
    "/v2/invoicing/invoices",
    { method: "POST", body, headers: { Prefer: "return=representation" } },
    "create invoice"
  );
  return (await res.json()) as PayPalInvoice;
}

export async function getInvoice(id: string): Promise<PayPalInvoice> {
  const res = await paypalRequest(
    `/v2/invoicing/invoices/${encodeURIComponent(id)}`,
    { method: "GET" },
    "get invoice"
  );
  return (await res.json()) as PayPalInvoice;
}

/** Sends the invoice to the recipient by email. PayPal returns 200 (with links) or 202 (empty). */
export async function sendInvoice(id: string): Promise<void> {
  await paypalRequest(
    `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`,
    { method: "POST", body: { send_to_recipient: true } },
    "send invoice"
  );
}

/** Emails the recipient a payment reminder for a sent invoice. */
export async function remindInvoice(
  id: string,
  { subject, note }: { subject: string; note: string }
): Promise<void> {
  await paypalRequest(
    `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`,
    { method: "POST", body: { subject, note, send_to_recipient: true } },
    "remind invoice"
  );
}

/** Deletes a DRAFT invoice (used by the seed script to clean up failed attempts). */
export async function deleteInvoice(id: string): Promise<void> {
  await paypalRequest(
    `/v2/invoicing/invoices/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    "delete invoice"
  );
}

/** Flattens a PayPal invoice into the fields the app uses. */
export function normalizeInvoice(inv: PayPalInvoice): InvoiceRecord {
  const billing = inv.primary_recipients?.[0]?.billing_info;
  const personName =
    billing?.name?.full_name ||
    [billing?.name?.given_name, billing?.name?.surname].filter(Boolean).join(" ") ||
    null;
  const total = inv.amount?.value ? Number(inv.amount.value) : 0;
  const due = inv.due_amount?.value ? Number(inv.due_amount.value) : total;
  return {
    id: inv.id,
    number: inv.detail?.invoice_number ?? null,
    status: inv.status,
    recipientName: billing?.business_name || personName,
    recipientEmail: billing?.email_address ?? null,
    total,
    amountDue: due,
    currency: inv.amount?.currency_code ?? inv.detail?.currency_code ?? "USD",
    dueDate: inv.detail?.payment_term?.due_date ?? null,
    invoiceDate: inv.detail?.invoice_date ?? null,
  };
}

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 10;

/** All invoices for this merchant (newest first), up to 1,000. */
export async function listInvoices(): Promise<InvoiceRecord[]> {
  const all: InvoiceRecord[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const query = new URLSearchParams({
      page: String(page),
      page_size: String(LIST_PAGE_SIZE),
      total_required: "true",
    });
    const res = await paypalRequest(`/v2/invoicing/invoices?${query}`, { method: "GET" }, "list invoices");
    const data = (await res.json()) as { items?: PayPalInvoice[]; total_pages?: number };
    const items = data.items ?? [];
    all.push(...items.map(normalizeInvoice));
    if (items.length < LIST_PAGE_SIZE || (data.total_pages !== undefined && page >= data.total_pages)) break;
  }
  return all;
}
