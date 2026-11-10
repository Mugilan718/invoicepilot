// Video assembly with the ffmpeg binary from ffmpeg-static (nothing to install system-wide).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { AUDIO_LEAD_S } from "./record.ts";
import type { Clip } from "./record.ts";
import { DemoError, type AudioFile } from "./tts.ts";

const require = createRequire(import.meta.url);
const FFMPEG = require("ffmpeg-static") as string;

const FPS = 30;
const FADE_S = 0.4;
/** Identical encoding settings for every part, so they can be joined without re-encoding. */
const OUTPUT_ARGS = [
  "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS),
  "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
  "-video_track_timescale", "15360", "-movflags", "+faststart",
];

function ffmpeg(args: string[], label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ["-hide_banner", "-y", ...args], { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => reject(new DemoError(`${label}: couldn't start ffmpeg (${err.message})`)));
    proc.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new DemoError(`${label}: ffmpeg exited with code ${code}\n${stderr.split("\n").slice(-12).join("\n")}`));
    });
  });
}

/** Media duration in seconds (parsed from ffmpeg's input info; ffprobe isn't bundled). */
export async function mediaDuration(file: string): Promise<number> {
  const out = await new Promise<string>((resolve) => {
    const proc = spawn(FFMPEG, ["-hide_banner", "-i", file], { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", () => resolve(stderr));
  });
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
  if (!m) throw new DemoError(`Couldn't read the duration of ${file}.`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 2-second title card from a PNG, fading in from black, with a silent audio track. */
export async function buildTitle(png: string, out: string, seconds = 2) {
  await ffmpeg(
    [
      "-loop", "1", "-framerate", String(FPS), "-t", String(seconds), "-i", png,
      "-f", "lavfi", "-t", String(seconds), "-i", "anullsrc=r=48000:cl=stereo",
      "-vf", `scale=1920:1080,setsar=1,fade=t=in:st=0:d=1`,
      "-shortest", ...OUTPUT_ARGS, out,
    ],
    "Title card"
  );
}

/** One section: trimmed screen recording + narration (starting after a short lead), with soft fades. */
export async function buildSection(clip: Clip, audio: AudioFile, out: string) {
  const total = Math.max(clip.duration, AUDIO_LEAD_S + audio.duration + 0.8);
  const t = total.toFixed(3);
  const fadeOutAt = (total - FADE_S).toFixed(3);
  const delayMs = Math.round(AUDIO_LEAD_S * 1000);
  await ffmpeg(
    [
      "-ss", clip.trimStart.toFixed(3), "-i", clip.path,
      "-i", audio.path,
      "-filter_complex",
      `[0:v]fps=${FPS},scale=1920:1080:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=10,` +
        `fade=t=in:st=0:d=${FADE_S},fade=t=out:st=${fadeOutAt}:d=${FADE_S}[v];` +
        `[1:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${delayMs}:all=1,apad,` +
        `afade=t=out:st=${fadeOutAt}:d=${FADE_S}[a]`,
      "-map", "[v]", "-map", "[a]", "-t", t,
      ...OUTPUT_ARGS, out,
    ],
    `Section "${clip.id}"`
  );
}

/** Joins parts that share identical encoding settings (no re-encode). */
export async function concatParts(parts: string[], listFile: string, out: string) {
  writeFileSync(listFile, parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", out], "Joining sections");
}
