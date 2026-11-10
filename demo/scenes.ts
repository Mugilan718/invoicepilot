// What happens on screen in each section. Actions are timed with d.cue("<phrase from the narration>").

import type { Page } from "playwright";
import { closingCardHtml } from "./cards.ts";
import type { SectionScript } from "./record.ts";
import { DemoError } from "./tts.ts";

const READY_TIMEOUT = 60_000;

/** The prompt typed in the chat section. */
export const CHAT_PROMPT = "Bill Acme Corp $1,200 for logo design, due in 14 days";

async function openDashboard(page: Page) {
  await page.goto("/dashboard");
  await page.locator(".ag-row.ip-row-overdue").first().waitFor({ timeout: READY_TIMEOUT });
  await page.getByText("Total outstanding").waitFor({ timeout: READY_TIMEOUT });
}

export const SCENES: Record<string, SectionScript> = {
  "1-problem": {
    setup: openDashboard,
    async run(d) {
      const p = d.page;
      await d.cue("chasing payment");
      await d.moveTo(p.getByText("Overdue", { exact: true }).first());
      await d.cue("Late invoices");
      const rows = p.locator(".ag-center-cols-container .ag-row.ip-row-overdue");
      const n = Math.min(await rows.count(), 4);
      for (let i = 0; i < n; i++) await d.moveTo(rows.nth(i), { ms: 700, dx: -200 });
      await d.cue("This is InvoicePilot");
      await d.moveTo(p.getByRole("link", { name: /InvoicePilot/ }).first());
    },
  },

  "2-intro": {
    async setup(page) {
      await page.goto("/");
      await page.getByText("Who are we billing today?").waitFor({ timeout: READY_TIMEOUT });
    },
    async run(d) {
      const p = d.page;
      await d.cue("AI agent");
      const examples = p.locator("main button").filter({ hasText: /Bill|Invoice|owes/ });
      const n = Math.min(await examples.count(), 3);
      for (let i = 0; i < n; i++) await d.moveTo(examples.nth(i), { ms: 650 });
      await d.cue("PayPal's Invoicing API");
      await d.moveTo(p.locator("#chat-input"));
    },
  },

  "3-chat": {
    async setup(page) {
      await page.goto("/");
      await page.locator("#chat-input").waitFor({ timeout: READY_TIMEOUT });
    },
    async run(d) {
      const p = d.page;
      const input = p.locator("#chat-input");
      await d.click(input);
      await d.cue("Bill Acme Corp");
      await d.type(CHAT_PROMPT);
      await p.keyboard.press("Enter");

      // Real draft from Gemini + PayPal; fail on an error/rate-limit bubble instead.
      const approve = p.getByRole("button", { name: "Approve & Send" });
      const chatError = p.locator("main div.bg-red-50, main div.bg-amber-50");
      await d.outcome(approve, chatError, "Chat agent didn't create a draft invoice");

      await d.cue("Here's the key design choice");
      await d.moveTo(approve, { dy: -120 }); // over the card's line items
      await d.cue("Approve and Send");
      await d.click(approve);

      const sent = p.getByText(/Sent to .+ via PayPal\./);
      const cardError = p.locator("main p.bg-red-50");
      await d.outcome(sent, cardError, "Sending the approved invoice failed");
      await d.moveTo(sent);
    },
  },

  "4-followups": {
    async setup(page) {
      await page.goto("/follow-ups");
      const drafted = page.getByRole("button", { name: "Draft reminders with AI" });
      const empty = page.getByText("All caught up! No overdue invoices.");
      await Promise.race([
        drafted.waitFor({ timeout: READY_TIMEOUT }),
        empty.waitFor({ timeout: READY_TIMEOUT }),
      ]);
      if (await empty.isVisible()) {
        throw new DemoError("Follow-ups has no overdue invoices. Run `npm run seed` first.");
      }
    },
    async run(d) {
      const p = d.page;
      const cards = p.locator("main li").filter({ hasText: "days overdue" });
      // The badge only: reminder notes can also contain the words "days overdue".
      const badge = (card: typeof cards) => card.getByText(/^\d+ days? overdue$/);

      await d.cue("lists every overdue invoice");
      await d.moveTo(badge(cards.first()), { ms: 700 });
      await d.cue("One click");
      await d.click(p.getByRole("button", { name: "Draft reminders with AI" }));

      const notes = p.locator('textarea[id^="note-"]');
      await d.outcome(notes, p.locator("main p.bg-red-50"), "Drafting reminders failed");

      // List is most overdue first: friendly ones are at the bottom.
      await d.cue("friendly when");
      await d.scrollTo(cards.last(), 1400);
      await d.moveTo(badge(cards.last()), { ms: 600 });
      await d.cue("firm but courteous");
      await d.scrollTo(cards.first(), 1400);
      await d.moveTo(badge(cards.first()), { ms: 600 });

      await d.cue("Any message can be edited");
      const firstNote = notes.first();
      await d.click(firstNote);
      await p.keyboard.press("Control+End");
      await d.type("\n\nP.S. Happy to set up a payment plan if that helps.");

      await d.cue("then sent");
      const firstCard = cards.first();
      await d.click(firstCard.getByRole("button", { name: "Send reminder" }));
      await d.outcome(firstCard.getByText("Reminder sent"), firstCard.locator("p.bg-red-50"), "Sending the reminder failed");
      await d.moveTo(firstCard.getByText("Reminder sent"), { ms: 600 });
    },
  },

  "5-dashboard": {
    setup: openDashboard,
    async run(d) {
      const p = d.page;
      await d.cue("live totals");
      await d.moveTo(p.locator(".ag-row.ip-row-total").first(), { dx: -300 });
      await d.cue("filters");
      await d.click(p.getByRole("button", { name: /^Overdue/ }));
      await d.cue("highlighted overdue");
      const rows = p.locator(".ag-center-cols-container .ag-row.ip-row-overdue");
      const n = Math.min(await rows.count(), 3);
      for (let i = 0; i < n; i++) await d.moveTo(rows.nth(i), { ms: 600, dx: -150 });

      await d.cue("reliability rating");
      const badge = p.getByText(/^(Often late|Sometimes late|Reliable)$/).first();
      await d.scrollTo(badge, 1200);
      await d.moveTo(badge); // shows the "why" tooltip

      await d.cue("Generate Insights");
      const generate = p.getByRole("button", { name: /Generate insights|Regenerate/ });
      await d.scrollTo(generate, 1200);
      await d.click(generate);
      const panel = p.locator("section").filter({ hasText: "AI insights" });
      await d.outcome(panel.locator("li"), panel.locator("p.bg-red-50"), "Generating insights failed");
      await d.scrollTo(panel.locator("li").first(), 1000);
      // Give viewers time to read the insights: glide across each one, with a short pause.
      const items = panel.locator("li");
      const count = Math.min(await items.count(), 4);
      for (let i = 0; i < count; i++) {
        await d.moveTo(items.nth(i), { ms: 700 });
        await p.waitForTimeout(900);
      }
    },
  },

  "6-closing": {
    async setup(page) {
      await page.setContent(closingCardHtml(), { waitUntil: "load" });
    },
    async run() {
      // Static card with CSS animations; the narration carries this section.
    },
  },
};
