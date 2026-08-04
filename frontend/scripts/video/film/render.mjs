#!/usr/bin/env node
"use strict";

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");
const artifactRoot = path.join(repo, "artifacts", "skybao-film");
const blendPath = path.join(artifactRoot, "skybao-film.blend");
const audioPath = path.join(artifactRoot, "audio", "skybao-mix.wav");
const deliverableRoot = path.join(artifactRoot, "deliverables");
const scriptArgs = process.argv.slice(2);

function has(flag) {
  return scriptArgs.includes(flag);
}

function usage() {
  console.log(`SkyBao 40-second film renderer

Usage:
  yarn video:film                  Build a 960x540 review MP4
  yarn video:film --preview        Same as the default
  yarn video:film --final          Build the 1920x1080 H.264 master
  yarn video:film --build-only     Generate audio, validate, and save the .blend

Options:
  --keep-frames                    Retain rendered PNG intermediates
  BLENDER_BIN=/path/to/blender     Override Blender executable
  FFMPEG_BIN=/path/to/ffmpeg       Override FFmpeg executable
  FFPROBE_BIN=/path/to/ffprobe     Override FFprobe executable`);
}

if (has("--help") || has("-h")) {
  usage();
  process.exit(0);
}

const modeFlags = ["--preview", "--final", "--build-only"].filter(has);
if (modeFlags.length > 1) {
  throw new Error(`choose one render mode, received: ${modeFlags.join(", ")}`);
}
const mode = has("--final")
  ? "final"
  : has("--build-only")
    ? "build-only"
    : "preview";
const keepFrames = has("--keep-frames");
const unknown = scriptArgs.filter(
  (arg) =>
    !["--preview", "--final", "--build-only", "--keep-frames"].includes(arg)
);
if (unknown.length) throw new Error(`unknown option(s): ${unknown.join(", ")}`);

function commandFrom(candidates, envName) {
  if (process.env[envName]) return process.env[envName];
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && fs.existsSync(candidate))
      return candidate;
    if (!candidate.includes(path.sep)) {
      const found = spawnSync("which", [candidate], { encoding: "utf8" });
      if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
    }
  }
  throw new Error(
    `cannot find ${envName}; set ${envName}=/absolute/path/to/executable`
  );
}

const blender = commandFrom(
  ["/Applications/Blender.app/Contents/MacOS/Blender", "blender"],
  "BLENDER_BIN"
);
const ffmpeg =
  mode === "build-only"
    ? null
    : commandFrom(
        ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"],
        "FFMPEG_BIN"
      );
const ffprobe =
  mode === "build-only"
    ? null
    : commandFrom(
        ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "ffprobe"],
        "FFPROBE_BIN"
      );

function run(command, args, label, options = {}) {
  console.log(`\n[${label}]`);
  const result = spawnSync(command, args, {
    cwd: repo,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture
      ? `\n${result.stdout || ""}${result.stderr || ""}`
      : "";
    throw new Error(`${label} failed with exit ${result.status}${details}`);
  }
  return result;
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

fs.mkdirSync(deliverableRoot, { recursive: true });

run(
  process.execPath,
  [path.join(here, "generate-audio.mjs")],
  "deterministic audio"
);
run(process.execPath, [path.join(here, "validate.mjs")], "source validation");

const blenderArgs = [
  "--background",
  "--factory-startup",
  "--python",
  path.join(here, "build-blender.py"),
  "--",
  "--repo",
  repo,
  "--out",
  blendPath,
];

let framesDir = null;
if (mode !== "build-only") {
  framesDir = path.join(artifactRoot, "frames", mode);
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  blenderArgs.push("--quality", mode);
}

run(
  blender,
  blenderArgs,
  mode === "build-only" ? "build Blender project" : `render ${mode} frames`
);

if (!fs.existsSync(blendPath))
  throw new Error(`Blender did not create ${blendPath}`);

if (mode === "build-only") {
  console.log(`\nReady: ${blendPath}`);
  process.exit(0);
}

const frames = fs
  .readdirSync(framesDir)
  .filter((name) => /^frame-\d{6}\.png$/.test(name))
  .sort();
if (frames.length !== 1200) {
  throw new Error(
    `expected 1200 rendered frames in ${framesDir}, found ${frames.length}`
  );
}
for (let index = 0; index < frames.length; index += 1) {
  const expected = `frame-${String(index + 1).padStart(6, "0")}.png`;
  if (frames[index] !== expected) {
    throw new Error(
      `non-contiguous render at ${frames[index]}; expected ${expected}`
    );
  }
}

const outputName =
  mode === "final" ? "skybao-40s-master.mp4" : "skybao-40s-preview.mp4";
const outputPath = path.join(deliverableRoot, outputName);
const dimensions = mode === "final" ? "1920x1080" : "960x540";
const encodeArgs = [
  "-hide_banner",
  "-y",
  "-framerate",
  "30",
  "-start_number",
  "1",
  "-i",
  path.join(framesDir, "frame-%06d.png"),
  "-i",
  audioPath,
  "-map",
  "0:v:0",
  "-map",
  "1:a:0",
  "-frames:v",
  "1200",
  "-r",
  "30",
  "-vf",
  "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
  "-c:v",
  "libx264",
  "-preset",
  mode === "final" ? "slow" : "medium",
  "-crf",
  mode === "final" ? "18" : "21",
  "-pix_fmt",
  "yuv420p",
  "-colorspace",
  "bt709",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-af",
  "loudnorm=I=-16:TP=-1.5:LRA=8",
  "-ar",
  "48000",
  "-c:a",
  "aac",
  "-b:a",
  mode === "final" ? "320k" : "192k",
  "-movflags",
  "+faststart",
  "-shortest",
  outputPath,
];
run(ffmpeg, encodeArgs, `encode ${outputName}`);

const probe = run(
  ffprobe,
  [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,pix_fmt,color_space,color_transfer,color_primaries",
    "-of",
    "json",
    outputPath,
  ],
  "verify encoded master",
  { capture: true }
);
const metadata = JSON.parse(probe.stdout);
const video = metadata.streams.find((stream) => stream.codec_type === "video");
const audio = metadata.streams.find((stream) => stream.codec_type === "audio");
const duration = Number(metadata.format.duration);
const [expectedWidth, expectedHeight] = dimensions.split("x").map(Number);
if (
  !video ||
  video.width !== expectedWidth ||
  video.height !== expectedHeight
) {
  throw new Error(`encoded video dimensions do not match ${dimensions}`);
}
if (video.r_frame_rate !== "30/1")
  throw new Error(`encoded FPS is ${video.r_frame_rate}, expected 30/1`);
if (
  video.color_space !== "bt709" ||
  video.color_transfer !== "bt709" ||
  video.color_primaries !== "bt709"
) {
  throw new Error(
    `encoded color tags are ${video.color_primaries}/${video.color_transfer}/${video.color_space}, expected bt709/bt709/bt709`
  );
}
if (!audio || audio.sample_rate !== "48000" || audio.channels !== 2) {
  throw new Error("encoded audio is not stereo 48kHz");
}
if (Math.abs(duration - 40) > 0.05)
  throw new Error(`encoded duration ${duration}s is not 40s`);

const report = {
  title: "SkyBao · The Acme Workspace Flow",
  mode,
  durationSeconds: duration,
  frames: 1200,
  fps: 30,
  dimensions,
  video,
  audio,
  files: {
    video: path.relative(repo, outputPath),
    blend: path.relative(repo, blendPath),
    mix: path.relative(repo, audioPath),
  },
  sha256: {
    video: sha256(outputPath),
    blend: sha256(blendPath),
    mix: sha256(audioPath),
  },
};
const reportPath = path.join(deliverableRoot, `render-report-${mode}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

if (!keepFrames) fs.rmSync(framesDir, { recursive: true, force: true });

console.log(`\nSkyBao film ready`);
console.log(`  video:  ${outputPath}`);
console.log(`  blend:  ${blendPath}`);
console.log(`  report: ${reportPath}`);
console.log(`  sha256: ${report.sha256.video}`);
console.log(
  `  frames: ${keepFrames ? framesDir : "removed after verified encode"}`
);
