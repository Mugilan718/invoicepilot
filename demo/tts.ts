// Voiceover: one WAV per narration section via Gemini text-to-speech.
// Calls the REST endpoint directly: with @google/genai v3 the API rejects the SDK's
// speechConfig request shape for TTS models, while the plain REST shape works.
// Audio is cached by a hash of (model, voice, style, text), so reruns don't re-generate it.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// gemini-2.5-flash-preview-tts speaks at a natural pace (~145 wpm); gemini-3.8-flash-tts reads the
// same text far slower (~75-95 wpm), which pushes the video past 3 minutes. Keep one model for every
// section so the voice stays consistent; the second is only a fallback.
const TTS_MODELS = (process.env.DEMO_TTS_MODELS ?? "gemini-2.5-flash-preview-tts,gemini-3.8-flash-tts")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const MAX_ATTEMPTS_PER_MODEL = 3;

export interface NarrationSection {
  id: string;
  screen: string;
  text: string;
}

export interface Narration {
  voice: string;
  style: string;
  sections: NarrationSection[];
}

export interface AudioFile {
  path: string;
  /** Seconds. */
  duration: number;
}

export class DemoError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Duration of a PCM WAV file from its header (fmt byte rate + data chunk size). */
export function wavDuration(buf: Buffer): number {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new DemoError("Not a WAV file.");
  }
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(offset + 8 + 8);
    if (id === "data") {
      // Streamed WAVs may carry a placeholder size; fall back to the bytes actually present.
      const dataBytes = Math.min(size, buf.length - (offset + 8));
      if (!byteRate) throw new DemoError("WAV has no fmt chunk.");
      return dataBytes / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  throw new DemoError("WAV has no data chunk.");
}

/** Wraps raw 16-bit mono PCM (e.g. "audio/L16;rate=24000") in a WAV header. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function synthesize(model: string, voice: string, prompt: string): Promise<Buffer> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string };
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
  } | null;
  if (!res.ok) {
    const err = new DemoError(`${model} returned ${res.status}: ${body?.error?.message ?? "no details"}`);
    (err as DemoError & { status?: number }).status = res.status;
    throw err;
  }
  const part = body?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!part?.data) throw new DemoError(`${model} returned no audio.`);
  const audio = Buffer.from(part.data, "base64");
  const mime = (part.mimeType ?? "").toLowerCase();
  if (mime.includes("wav")) return audio;
  const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000);
  return pcmToWav(audio, rate);
}

/** Generates (or reuses) the WAV for one section. */
export async function voiceSection(narration: Narration, section: NarrationSection, dir: string): Promise<AudioFile> {
  const prompt = `${narration.style}:\n\n${section.text}`;
  const hash = createHash("sha256")
    .update(JSON.stringify([TTS_MODELS[0], narration.voice, prompt]))
    .digest("hex")
    .slice(0, 12);
  const path = join(dir, `${section.id}-${hash}.wav`);

  if (existsSync(path)) {
    const duration = wavDuration(readFileSync(path));
    console.log(`  ${section.id}: cached audio (${duration.toFixed(1)}s)`);
    return { path, duration };
  }

  if (!process.env.GEMINI_API_KEY) throw new DemoError("GEMINI_API_KEY is missing from .env.local.");

  let lastError: unknown;
  for (const model of TTS_MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const started = Date.now();
        const wav = await synthesize(model, narration.voice, prompt);
        const duration = wavDuration(wav);
        writeFileSync(path, wav);
        console.log(`  ${section.id}: ${duration.toFixed(1)}s of audio from ${model} (${Date.now() - started}ms)`);
        if (model !== TTS_MODELS[0]) {
          console.warn(
            `  WARNING: ${section.id} used the fallback TTS model, so its voice may sound different. ` +
              `Delete ${path} and rerun later to regenerate it with ${TTS_MODELS[0]}.`
          );
        }
        return { path, duration };
      } catch (err) {
        lastError = err;
        const status = (err as { status?: number }).status;
        const retryable = status === undefined || status === 429 || status >= 500;
        console.warn(`  ${section.id}: ${model} attempt ${attempt} failed: ${(err as Error).message.slice(0, 200)}`);
        if (!retryable) break;
        // Free-tier TTS limits are per minute: back off generously on 429.
        if (attempt < MAX_ATTEMPTS_PER_MODEL) await sleep(status === 429 ? 25_000 * attempt : 3_000 * attempt);
      }
    }
  }
  throw new DemoError(
    `Text-to-speech failed for section "${section.id}": ${(lastError as Error)?.message ?? lastError}. ` +
      `If Gemini TTS isn't available on your key, an offline engine such as Piper could be swapped in here.`
  );
}
