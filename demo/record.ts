// Screen recording with Playwright (Chromium). Each section is recorded in its own browser
// context, paced against its narration: actions wait for "cues" (a phrase in the narration,
// converted to a time from the audio length), and every clip lasts at least as long as its audio.

import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { DemoError, type AudioFile, type NarrationSection } from "./tts.ts";

export const VIEWPORT = { width: 1920, height: 1080 };
/** Narration starts this long after the clip starts. */
export const AUDIO_LEAD_S = 0.6;
/** Calm pause after the narration ends. */
const TAIL_S = 1.2;
/** Gemini (plus fallbacks) can take a while on the free tier. */
const AI_TIMEOUT_MS = 120_000;

export interface Clip {
  id: string;
  path: string;
  /** Seconds to cut from the start of the raw recording (page loading). */
  trimStart: number;
  /** Seconds of usable footage after the trim. */
  duration: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Injected into every recorded page: a visible cursor with a click ripple, and no Next.js dev overlay. */
const RECORDING_INIT_SCRIPT = `(() => {
  const install = () => {
    if (document.getElementById("__demo-cursor")) return;
    const style = document.createElement("style");
    style.textContent = \`
      nextjs-portal { display: none !important; }
      #__demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
        transform: translate(-100px, -100px); will-change: transform; }
      #__demo-cursor svg { width: 28px; height: 28px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
      #__demo-cursor .ring { position: absolute; left: -16px; top: -16px; width: 32px; height: 32px; border-radius: 50%;
        background: rgba(79,70,229,.35); transform: scale(0); opacity: 0; }
      #__demo-cursor.down .ring { animation: demo-ripple .45s ease-out; }
      @keyframes demo-ripple { from { transform: scale(.3); opacity: .9; } to { transform: scale(1.6); opacity: 0; } }
    \`;
    document.head.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "__demo-cursor";
    cursor.innerHTML = '<div class="ring"></div><svg viewBox="0 0 24 24"><path d="M4 2l16 10.5-7 1.5 4 7.5-3 1.5-4-7.5L4 20z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cursor);
    document.addEventListener("mousemove", (e) => {
      cursor.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)";
    }, true);
    document.addEventListener("mousedown", () => {
      cursor.classList.remove("down");
      void cursor.offsetWidth;
      cursor.classList.add("down");
    }, true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
})();`;

/** Drives one section: cue timing, smooth cursor movement, human-like typing. */
export class Director {
  page: Page;
  private section: NarrationSection;
  private audio: AudioFile;
  private start = 0;
  private x = VIEWPORT.width / 2;
  private y = VIEWPORT.height / 2;

  constructor(page: Page, section: NarrationSection, audio: AudioFile) {
    this.page = page;
    this.section = section;
    this.audio = audio;
  }

  /** Marks the start of usable footage (everything before is trimmed). */
  async begin() {
    await this.page.mouse.move(this.x, this.y);
    this.start = Date.now();
  }

  elapsed() {
    return (Date.now() - this.start) / 1000;
  }

  /** Waits until the narration reaches `phrase` (estimated by its position in the text). */
  async cue(phrase: string) {
    const idx = this.section.text.indexOf(phrase);
    if (idx < 0) throw new DemoError(`Cue "${phrase}" not found in narration for ${this.section.id}.`);
    const at = AUDIO_LEAD_S + (this.audio.duration * idx) / this.section.text.length;
    const wait = at - this.elapsed();
    if (wait > 0) await sleep(wait * 1000);
  }

  /** Holds until the narration (plus a calm tail) is over, and at least `minHoldMs` from now. */
  async finish(minHoldMs = 1500) {
    const narrationEnd = AUDIO_LEAD_S + this.audio.duration + TAIL_S;
    const wait = Math.max(minHoldMs / 1000, narrationEnd - this.elapsed());
    await sleep(wait * 1000);
    return this.elapsed();
  }

  /** Eased cursor glide to a point. */
  async moveToPoint(tx: number, ty: number, ms?: number) {
    const dist = Math.hypot(tx - this.x, ty - this.y);
    const duration = ms ?? Math.min(900, 250 + dist * 0.6);
    const steps = Math.max(8, Math.round(duration / 16));
    const sx = this.x;
    const sy = this.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
      await this.page.mouse.move(sx + (tx - sx) * e, sy + (ty - sy) * e);
      await sleep(duration / steps);
    }
    this.x = tx;
    this.y = ty;
  }

  /** Glides to the center of an element (scrolling it into view first if needed). */
  async moveTo(target: Locator, opts: { ms?: number; dx?: number; dy?: number } = {}) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new DemoError(`${this.section.id}: element is not visible to move to.`);
    await this.moveToPoint(box.x + box.width / 2 + (opts.dx ?? 0), box.y + box.height / 2 + (opts.dy ?? 0), opts.ms);
  }

  async click(target: Locator) {
    await this.moveTo(target);
    await sleep(120);
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
    await sleep(150);
  }

  /** Types like a person: variable delay, small pauses after spaces and punctuation. */
  async type(text: string) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await sleep(/[ ,.]/.test(ch) ? rand(90, 170) : rand(45, 105));
    }
  }

  /** Smoothly scrolls the app's scroll container so `target` is centered. */
  async scrollTo(target: Locator, settleMs = 900) {
    await target.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
    await sleep(settleMs);
  }

  /** Smooth scroll of the main scroll container by `dy` pixels. */
  async scrollBy(dy: number, settleMs = 1100) {
    await this.page.locator("main").first().evaluate((el, d) => el.scrollBy({ top: d, behavior: "smooth" }), dy);
    await sleep(settleMs);
  }

  /** Waits for a success element, failing fast (with its text) if an error element appears first. */
  async outcome(success: Locator, failure: Locator, what: string, timeout = AI_TIMEOUT_MS) {
    const ok = success.first().waitFor({ state: "visible", timeout }).then(() => "ok" as const);
    const bad = failure.first().waitFor({ state: "visible", timeout }).then(() => "error" as const);
    let result: "ok" | "error";
    try {
      result = await Promise.race([ok, bad]);
    } catch {
      throw new DemoError(`${what}: timed out after ${Math.round(timeout / 1000)}s.`);
    } finally {
      ok.catch(() => {});
      bad.catch(() => {});
    }
    if (result === "error") {
      const text = (await failure.first().innerText().catch(() => "")).trim();
      throw new DemoError(`${what}: the app showed an error: "${text || "unknown error"}"`);
    }
  }
}

export interface SectionScript {
  /** Navigate and wait until the screen is ready (not recorded in the final clip). */
  setup: (page: Page) => Promise<void>;
  /** The on-camera actions. */
  run: (d: Director) => Promise<void>;
}

/** Records one section into `clipsDir/<id>.webm`. */
export async function recordSection(
  browser: Browser,
  section: NarrationSection,
  audio: AudioFile,
  script: SectionScript,
  clipsDir: string,
  baseURL: string
): Promise<Clip> {
  const tmpDir = join(clipsDir, `tmp-${section.id}`);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const context = await browser.newContext({
    baseURL,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: "light",
    recordVideo: { dir: tmpDir, size: VIEWPORT },
  });
  await context.addInitScript(RECORDING_INIT_SCRIPT);
  const page = await context.newPage();
  const recordingStarted = Date.now();
  const director = new Director(page, section, audio);
  const video = page.video();

  let duration = 0;
  let trimStart = 0;
  try {
    await script.setup(page);
    await director.begin();
    trimStart = (Date.now() - recordingStarted) / 1000;
    await script.run(director);
    duration = await director.finish();
  } catch (err) {
    const shot = join(clipsDir, `failure-${section.id}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    await context.close().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    throw new DemoError(`Section "${section.id}" failed: ${msg}\n  Screenshot: ${shot}`);
  }

  await context.close(); // flushes the video file
  const raw = await video?.path();
  if (!raw) throw new DemoError(`Section "${section.id}": Playwright produced no video.`);
  const path = join(clipsDir, `${section.id}.webm`);
  rmSync(path, { force: true });
  renameSync(raw, path);
  rmSync(tmpDir, { recursive: true, force: true });
  return { id: section.id, path, trimStart, duration };
}

/** Renders HTML to a 1920x1080 PNG (used for the opening title card). */
export async function renderPng(browser: Browser, html: string, out: string) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out });
  await page.close();
}
