// Seeds the PayPal SANDBOX with demo invoices for the Follow-ups view.
//
//   npm run seed            try real past due dates first, fall back to future dates + DEMO_TODAY
//   npm run seed -- --future   skip the past-date attempt
//
// Runs directly with Node's built-in TypeScript support; env comes from .env.local.
// Every run creates NEW invoices (sandbox only).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PayPalError,
  createDraftInvoice,
  deleteInvoice,
  sendInvoice,
  type InvoiceItemInput,
} from "../lib/paypal.ts";
import { addDays, localIsoDate } from "../lib/demo-clock.ts";

interface SeedSpec {
  client: string;
  items: InvoiceItemInput[];
  /** Due date relative to the (demo) "today": negative = overdue by that many days. */
  dueOffset: number;
}

const SPECS: SeedSpec[] = [
  { client: "Acme Corp", items: [{ name: "Website maintenance (monthly)", quantity: 1, unitAmount: 350 }], dueOffset: -3 },
  { client: "Bloom Bakery", items: [{ name: "Menu redesign", quantity: 1, unitAmount: 480 }], dueOffset: -12 },
  {
    client: "Acme Corp",
    items: [{ name: "Social media graphics", quantity: 10, unitAmount: 65 }],
    dueOffset: -21,
  },
  {
    client: "Nova Studio",
    items: [
      { name: "Brand identity package", quantity: 1, unitAmount: 2000 },
      { name: "Brand guidelines PDF", quantity: 1, unitAmount: 400 },
    ],
    dueOffset: -40,
  },
  { client: "Bloom Bakery", items: [{ name: "Product photography session", quantity: 1, unitAmount: 900 }], dueOffset: 10 },
];

/** In future mode, the demo "today" is this many days ahead, so every due date is still in the future. */
const FUTURE_SHIFT_DAYS = 45;
const NOTE = "Demo invoice created by the InvoicePilot seed script (PayPal sandbox).";

function loadClientEmails(): Map<string, string> {
  const testEmail = process.env.PAYPAL_TEST_CUSTOMER_EMAIL;
  if (!testEmail || testEmail === "the_personal_sandbox_email") {
    throw new Error("Set PAYPAL_TEST_CUSTOMER_EMAIL in .env.local first.");
  }
  const raw = JSON.parse(readFileSync(join(process.cwd(), "data", "clients.json"), "utf8")) as {
    name: string;
    email: string;
  }[];
  return new Map(raw.map((c) => [c.name, c.email.includes("{{") ? testEmail : c.email]));
}

const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const total = (items: InvoiceItemInput[]) => items.reduce((s, it) => s + it.quantity * it.unitAmount, 0);

interface Created {
  spec: SeedSpec;
  id: string;
  number: string | null;
  dueDate: string;
}

async function createAndSend(
  spec: SeedSpec,
  email: string,
  dueDate: string,
  invoiceDate: string | undefined
): Promise<Created> {
  const inv = await createDraftInvoice({
    email,
    recipientName: spec.client,
    items: spec.items,
    dueDate,
    invoiceDate,
    note: NOTE,
  });
  try {
    await sendInvoice(inv.id);
  } catch (err) {
    // Don't leave a half-seeded draft behind.
    await deleteInvoice(inv.id).catch(() => {});
    throw err;
  }
  return { spec, id: inv.id, number: inv.detail?.invoice_number ?? null, dueDate };
}

/** A 4xx from PayPal that is about the due/invoice date (not some other problem). */
const isDateRejection = (err: unknown) =>
  err instanceof PayPalError &&
  err.status >= 400 &&
  err.status < 500 &&
  /due_date|invoice_date|DUE_DATE|INVOICE_DATE|past/i.test(err.body);

/** Turns known PayPal account problems into actionable messages. */
function explain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof PayPalError && err.body.includes("INR_FOREIGN_CURRENCY_BLOCKED")) {
    return (
      "PayPal refused to SEND: the recipient sandbox account (PAYPAL_TEST_CUSTOMER_EMAIL) is registered in India,\n" +
      "and PayPal doesn't allow sending invoices to customers within India.\n\n" +
      "Fix: in the PayPal Developer Dashboard > Sandbox accounts > Create account, make a PERSONAL account\n" +
      "with country United States, put its email in PAYPAL_TEST_CUSTOMER_EMAIL in .env.local, and run the seed again.\n\n" +
      `PayPal said: ${msg}`
    );
  }
  return msg;
}

async function main() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.local first.");
  }
  const emails = loadClientEmails();
  const realToday = localIsoDate(new Date());
  const created: Created[] = [];

  const emailFor = (spec: SeedSpec) => {
    const email = emails.get(spec.client);
    if (!email) throw new Error(`Client "${spec.client}" is not in data/clients.json.`);
    return email;
  };

  // 1) Try real past due dates (backdating the invoice date 30 days before the due date).
  let mode: "past" | "future" = process.argv.includes("--future") ? "future" : "past";
  if (mode === "past") {
    const probe = SPECS[0];
    const due = addDays(realToday, probe.dueOffset);
    const invoiceDate = addDays(due, -30);
    console.log(`Trying a past due date (${due}, invoice date ${invoiceDate})...`);
    try {
      created.push(await createAndSend(probe, emailFor(probe), due, invoiceDate));
      console.log("PayPal accepted past due dates.");
    } catch (err) {
      if (!isDateRejection(err)) throw err;
      console.log(`PayPal rejected past dates, switching to future dates.\n  ${(err as Error).message}`);
      mode = "future";
    }
  }

  // 2) Create and send the rest.
  const demoToday = mode === "future" ? addDays(realToday, FUTURE_SHIFT_DAYS) : realToday;
  for (const spec of SPECS) {
    if (created.some((c) => c.spec === spec)) continue;
    const due = addDays(demoToday, spec.dueOffset);
    // Future mode: let PayPal default the invoice date to today (a future invoice date would schedule it).
    const invoiceDate = mode === "past" ? addDays(due, -30) : undefined;
    const c = await createAndSend(spec, emailFor(spec), due, invoiceDate);
    created.push(c);
    console.log(`  sent ${c.number ?? c.id}  ${spec.client.padEnd(13)} ${money(total(spec.items)).padStart(10)}  due ${due}`);
  }

  // 3) Summary.
  console.log(`\nSeeded ${created.length} sent invoice(s):`);
  for (const c of created) {
    const offset = c.spec.dueOffset;
    const label = offset < 0 ? `${-offset} days overdue` : `due in ${offset} days`;
    console.log(`  ${(c.number ?? c.id).padEnd(10)} ${c.spec.client.padEnd(13)} ${money(total(c.spec.items)).padStart(10)}  due ${c.dueDate}  (${label})`);
  }

  if (mode === "future") {
    console.log(
      `\nPayPal doesn't allow past due dates, so the due dates are in the future.\n` +
        `Add this line to .env.local and restart the dev server to see them as overdue:\n\n` +
        `  DEMO_TODAY=${demoToday}\n`
    );
  } else {
    console.log("\nReal past due dates were used; DEMO_TODAY is not needed.");
  }
}

main().catch((err: unknown) => {
  console.error(`\nSeed failed: ${explain(err)}`);
  process.exit(1);
});
