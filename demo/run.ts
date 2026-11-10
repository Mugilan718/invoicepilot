// InvoicePilot demo video pipeline: narration (Gemini TTS) -> screen recording (Playwright)
// -> assembly (ffmpeg). Run with `npm run demo:video` while `npm run dev` is running.
//
//   npm run demo:video                     full run
//   npm run demo:video -- --audio-only     only generate/refresh the voiceover
//   npm run demo:video -- --assemble-only  re-assemble from the last recorded clips
//   npm run demo:video -- --from 4-followups
//                                          re-record from that section on, reusing earlier clips
//                                          (e.g. after a failure, without creating another invoice)
//   npm run demo:video -- --only 1-problem,5-dashboard
//                                          re-record just these sections, reusing all others
//
// Each full run creates ONE new invoice (sent) and sends ONE reminder in the PayPal sandbox.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { buildSection, buildTitle, concatParts, mediaDuration } from "./assemble.ts";
import { titleCardHtml } from "./cards.ts";
import { recordSection, renderPng, VIEWPORT, type Clip } from "./record.ts";
import { SCENES } from "./scenes.ts";
import { DemoError, voiceSection, type AudioFile, type Narration } from "./tts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "output");
const DIRS = { audio: join(OUT, "audio"), clips: join(OUT, "clips"), parts: join(OUT, "parts") };
const FINAL = join(OUT, "invoicepilot-demo.mp4");
const CLIPS_MANIFEST = join(DIRS.clips, "clips.json");
const BASE_URL = (process.env.DEMO_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const MAX_SECONDS = 175; // warn above 2:55
const TITLE_SECONDS = 2;

const argv = process.argv.slice(2);
const args = new Set(argv);
const fromIdx = argv.indexOf("--from");
const FROM_SECTION = fromIdx >= 0 ? argv[fromIdx + 1] : undefined;
const onlyIdx = argv.indexOf("--only");
const ONLY_SECTIONS = onlyIdx >= 0 ? (argv[onlyIdx + 1] ?? "").split(",").filter(Boolean) : undefined;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

function step(title: string) {
  console.log(`\n=== ${title} ===`);
}

/** Fails early with a clear message if the dev server isn't up or there's nothing overdue to show. */
async function preflight() {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/invoices`, { signal: AbortSignal.timeout(90_000) });
  } catch {
    throw new DemoError(`Can't reach ${BASE_URL}. Start the app with \`npm run dev\` first.`);
  }
  const body = (await res.json().catch(() => null)) as { invoices?: { overdue: boolean }[]; error?: string } | null;
  if (!res.ok || !body?.invoices) {
    throw new DemoError(`GET /api/invoices failed (${res.status}): ${body?.error ?? "no details"}`);
  }
  const overdue = body.invoices.filter((i) => i.overdue).length;
  if (overdue === 0) throw new DemoError("No overdue invoices in the sandbox. Run `npm run seed` first.");
  console.log(`  ${BASE_URL} is up: ${body.invoices.length} invoices, ${overdue} overdue`);
}

/** Opens every page once (and compiles the API routes cheaply) so nothing compiles on camera. */
async function warmUp(browser: Browser) {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: VIEWPORT });
  const page = await context.newPage();
  for (const [path, ready] of [
    ["/", "#chat-input"],
    ["/follow-ups", "main"],
    ["/dashboard", ".ag-row"],
  ] as const) {
    const t = Date.now();
    await page.goto(path);
    await page.locator(ready).first().waitFor({ timeout: 120_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    console.log(`  ${path} ready (${Date.now() - t}ms)`);
  }
  // These requests are rejected or return early before any Gemini call or email.
  const api = context.request;
  await api.post("/api/agent", { data: "{}" }).catch(() => {});
  await api.post("/api/reminders/draft", { data: { ids: [] } }).catch(() => {});
  await api.post("/api/reminders/send", { data: {} }).catch(() => {});
  await api.post("/api/invoices/warmup_check/send").catch(() => {});
  console.log("  API routes compiled");
  await context.close();
}

async function main() {
  for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });
  const narration = JSON.parse(readFileSync(join(HERE, "narration.json"), "utf8")) as Narration;
  for (const s of narration.sections) {
    if (!SCENES[s.id]) throw new DemoError(`narration.json section "${s.id}" has no scene in demo/scenes.ts.`);
  }

  // 1. Voiceover (cached between runs).
  step("1/3 Voiceover (Gemini TTS)");
  const audio = new Map<string, AudioFile>();
  for (const s of narration.sections) audio.set(s.id, await voiceSection(narration, s, DIRS.audio));
  const narrationTotal = [...audio.values()].reduce((sum, a) => sum + a.duration, 0);
  console.log(`  Total narration: ${narrationTotal.toFixed(1)}s`);
  if (args.has("--audio-only")) return;

  // 2. Screen recording.
  let clips: Clip[];
  const titlePng = join(DIRS.parts, "title.png");
  if (args.has("--assemble-only")) {
    if (!existsSync(CLIPS_MANIFEST)) throw new DemoError("No recorded clips yet. Run without --assemble-only first.");
    clips = JSON.parse(readFileSync(CLIPS_MANIFEST, "utf8")) as Clip[];
    step("2/3 Recording (skipped, reusing clips)");
  } else {
    step("2/3 Recording (Playwright)");
    const ids = narration.sections.map((s) => s.id);
    const checkId = (id: string, flag: string) => {
      if (!ids.includes(id)) throw new DemoError(`${flag} "${id}" isn't a section id (${ids.join(", ")}).`);
    };

    // Which sections to record now; the others reuse clips from the last run.
    let toRecord = new Set(ids);
    if (ONLY_SECTIONS) {
      ONLY_SECTIONS.forEach((id) => checkId(id, "--only"));
      toRecord = new Set(ONLY_SECTIONS);
    } else if (FROM_SECTION) {
      checkId(FROM_SECTION, "--from");
      toRecord = new Set(ids.slice(ids.indexOf(FROM_SECTION)));
    }
    const saved = new Map<string, Clip>(
      (existsSync(CLIPS_MANIFEST) ? (JSON.parse(readFileSync(CLIPS_MANIFEST, "utf8")) as Clip[]) : []).map((c) => [c.id, c])
    );
    for (const id of ids) {
      if (toRecord.has(id)) continue;
      const kept = saved.get(id);
      if (!kept || !existsSync(kept.path)) {
        throw new DemoError(`No saved clip for section "${id}" to reuse. Run a full recording (no --from/--only) first.`);
      }
      console.log(`  ${id}: reusing clip from the last run`);
    }

    await preflight();
    let browser: Browser;
    try {
      browser = await chromium.launch();
    } catch (err) {
      throw new DemoError(`Couldn't start Chromium. Run \`npx playwright install chromium\`.\n  ${(err as Error).message}`);
    }
    try {
      await warmUp(browser);
      await renderPng(browser, titleCardHtml(), titlePng);
      for (const s of narration.sections) {
        if (!toRecord.has(s.id)) continue;
        const t = Date.now();
        console.log(`  Recording ${s.id}...`);
        try {
          const clip = await recordSection(browser, s, audio.get(s.id)!, SCENES[s.id], DIRS.clips, BASE_URL);
          saved.set(s.id, clip);
          // Saved after every section, so a later failure can resume without redoing this one.
          writeFileSync(CLIPS_MANIFEST, JSON.stringify(ids.filter((id) => saved.has(id)).map((id) => saved.get(id)), null, 2));
          console.log(`  ${s.id}: ${clip.duration.toFixed(1)}s clip (took ${((Date.now() - t) / 1000).toFixed(0)}s)`);
        } catch (err) {
          const remaining = [...toRecord].filter((id) => ids.indexOf(id) >= ids.indexOf(s.id));
          if (err instanceof DemoError && remaining.length < ids.length) {
            err.message += `\n  Resume without redoing finished sections: npm run demo:video -- --only ${remaining.join(",")}`;
          }
          throw err;
        }
      }
    } finally {
      await browser.close();
    }
    clips = ids.map((id) => saved.get(id)!);
  }

  // 3. Assembly.
  step("3/3 Assembly (ffmpeg)");
  if (!existsSync(titlePng)) throw new DemoError("Title card image is missing. Run a full recording first.");
  const parts: string[] = [];
  const titleMp4 = join(DIRS.parts, "00-title.mp4");
  await buildTitle(titlePng, titleMp4, TITLE_SECONDS);
  parts.push(titleMp4);
  for (const clip of clips) {
    const a = audio.get(clip.id);
    if (!a) throw new DemoError(`No narration for recorded clip "${clip.id}".`);
    const out = join(DIRS.parts, `${clip.id}.mp4`);
    await buildSection(clip, a, out);
    parts.push(out);
    console.log(`  built ${clip.id}`);
  }
  await concatParts(parts, join(DIRS.parts, "list.txt"), FINAL);

  const total = await mediaDuration(FINAL);
  console.log(`\nDone: ${FINAL}`);
  console.log(`Duration: ${fmt(total)} (${total.toFixed(1)}s)`);
  if (total > MAX_SECONDS) {
    console.warn(`WARNING: longer than 2:55. Shorten the narration or the on-screen waits to stay under 3:00.`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nDemo video failed.\n  ${msg}`);
  console.error("Generated audio is kept in demo/output/audio, so a rerun only redoes what's missing.");
  process.exit(1);
});
