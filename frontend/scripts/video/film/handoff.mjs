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
const deliverableRoot = path.join(artifactRoot, "deliverables");
const reviewRoot = path.join(artifactRoot, "review");
const stagingRoot = path.join(repo, "artifacts", ".skybao-film-staging");
const masterPath = path.join(deliverableRoot, "skybao-40s-master.mp4");
const previewPath = path.join(deliverableRoot, "skybao-40s-preview.mp4");
const shotlist = JSON.parse(
  fs.readFileSync(path.join(here, "shotlist.json"), "utf8")
);
const fps = shotlist.format?.fps || 30;
const totalFrames = shotlist.format?.frames || 1200;

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
  throw new Error(`cannot find ${envName}`);
}

const ffmpeg = commandFrom(
  ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"],
  "FFMPEG_BIN"
);
const ffprobe = commandFrom(
  ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "ffprobe"],
  "FFPROBE_BIN"
);

function run(command, args, label, capture = false) {
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = capture
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

function zeroBased(frame) {
  return Math.max(0, Math.min(totalFrames - 1, Math.round(frame) - 1));
}

function shotStart(shot) {
  return Number(shot.frames.start);
}

function shotEnd(shot) {
  return Number(shot.frames.end);
}

function evenlySpaced(start, end, count) {
  if (count === 1) return [Math.round((start + end) / 2)];
  return Array.from({ length: count }, (_, index) =>
    Math.round(start + ((end - start) * index) / (count - 1))
  );
}

function selectExpression(frames) {
  return frames.map((frame) => `eq(n\\,${zeroBased(frame)})`).join("+");
}

function renderPng(input, output, filter) {
  run(
    ffmpeg,
    ["-v", "error", "-y", "-i", input, "-vf", filter, "-frames:v", "1", output],
    `render ${path.basename(output)}`
  );
}

function probe(file) {
  const result = run(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,color_space,color_transfer,color_primaries",
      "-of",
      "json",
      file,
    ],
    `probe ${path.basename(file)}`,
    true
  );
  return JSON.parse(result.stdout);
}

function assertImage(file, width, height) {
  const metadata = probe(file);
  const video = metadata.streams.find(
    (stream) => stream.codec_type === "video"
  );
  if (!video || video.width !== width || video.height !== height)
    throw new Error(`${file} is not ${width}x${height}`);
}

function promoteWithRollback(items, stage) {
  const rollbackRoot = path.join(stage, "rollback");
  const moved = [];
  try {
    for (const item of items) {
      if (!fs.existsSync(item.source))
        throw new Error(`missing staged handoff asset ${item.source}`);
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      const backup = path.join(
        rollbackRoot,
        `${moved.length}-${path.basename(item.target)}`
      );
      if (fs.existsSync(item.target)) {
        fs.mkdirSync(rollbackRoot, { recursive: true });
        fs.renameSync(item.target, backup);
      }
      try {
        fs.renameSync(item.source, item.target);
      } catch (error) {
        if (fs.existsSync(backup)) fs.renameSync(backup, item.target);
        throw error;
      }
      moved.push({ ...item, backup: fs.existsSync(backup) ? backup : null });
    }
  } catch (error) {
    for (const item of moved.reverse()) {
      if (fs.existsSync(item.target)) fs.rmSync(item.target, { force: true });
      if (item.backup && fs.existsSync(item.backup))
        fs.renameSync(item.backup, item.target);
    }
    throw error;
  }
  fs.rmSync(rollbackRoot, { recursive: true, force: true });
}

if (!fs.existsSync(masterPath) || !fs.existsSync(previewPath))
  throw new Error("both the final master and preview MP4 are required");

fs.mkdirSync(stagingRoot, { recursive: true });
const stage = fs.mkdtempSync(path.join(stagingRoot, "handoff-"));
const stagedByTarget = new Map();

function staged(relative) {
  const source = path.join(stage, relative);
  const target = path.join(artifactRoot, relative);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  stagedByTarget.set(relative, source);
  return { source, target };
}

const posterShot = shotlist.shots.find((shot) => shot.id === "work-board-drag");
if (!posterShot) throw new Error("shotlist is missing work-board-drag");
const posterFrame = Math.round(
  shotStart(posterShot) + (shotEnd(posterShot) - shotStart(posterShot)) * 0.73
);
const poster = staged("deliverables/skybao-poster.png");
renderPng(
  masterPath,
  poster.source,
  `select='${selectExpression([posterFrame])}'`
);

const fullSheet = staged("review/full-preview-1s-contact-sheet.png");
renderPng(
  masterPath,
  fullSheet.source,
  "fps=1,scale=320:180:flags=lanczos,tile=6x7:nb_frames=40"
);
const previewSheet = staged("review/preview-1s-contact-sheet.png");
renderPng(
  previewPath,
  previewSheet.source,
  "fps=1,scale=320:180:flags=lanczos,tile=6x7:nb_frames=40"
);

const shotCenters = shotlist.shots.map((shot) =>
  Math.round((shotStart(shot) + shotEnd(shot)) / 2)
);
const contactSheet = staged("review/contact-sheet.png");
renderPng(
  masterPath,
  contactSheet.source,
  `select='${selectExpression(shotCenters)}',scale=384:216:flags=lanczos,tile=5x4:nb_frames=${shotCenters.length}`
);

const navigationShots = shotlist.shots.filter(
  (shot) => shot.kind === "navigation"
);
if (navigationShots.length !== 4)
  throw new Error(
    `expected four navigation shots, found ${navigationShots.length}`
  );
const flipFrames = navigationShots.flatMap((shot) =>
  evenlySpaced(shotStart(shot), shotEnd(shot), 5)
);
const flipSheet = staged("review/flip-contact-sheet.png");
renderPng(
  masterPath,
  flipSheet.source,
  `select='${selectExpression(flipFrames)}',scale=384:216:flags=lanczos,tile=5x4:nb_frames=${flipFrames.length}`
);
const fullPreviewFlips = staged("review/full-preview-flips.png");
fs.copyFileSync(flipSheet.source, fullPreviewFlips.source);

const firstNavigationFrames = evenlySpaced(
  shotStart(navigationShots[0]),
  shotEnd(navigationShots[0]),
  12
);
const firstNavigationSheet = staged(
  "review/assistant-to-knowledge-contact-sheet.png"
);
renderPng(
  masterPath,
  firstNavigationSheet.source,
  `select='${selectExpression(firstNavigationFrames)}',scale=480:270:flags=lanczos,tile=4x3:nb_frames=12`
);

const navigationFrames = navigationShots.flatMap((shot) =>
  evenlySpaced(shotStart(shot), shotEnd(shot), 3)
);
const navigationSheet = staged("review/nav-capture-contact-sheet.png");
renderPng(
  masterPath,
  navigationSheet.source,
  `select='${selectExpression(navigationFrames)}',scale=480:270:flags=lanczos,tile=4x3:nb_frames=12`
);

const sampleFrames = evenlySpaced(30, totalFrames - 30, 20);
const sampleSheet = staged("review/v2-samples-contact-sheet.png");
renderPng(
  masterPath,
  sampleSheet.source,
  `select='${selectExpression(sampleFrames)}',scale=384:216:flags=lanczos,tile=5x4:nb_frames=20`
);

const boundary = staged("review/assistant-to-knowledge-boundary.mp4");
const boundaryDuration =
  (shotEnd(navigationShots[0]) - shotStart(navigationShots[0]) + 1) / fps;
run(
  ffmpeg,
  [
    "-v",
    "error",
    "-y",
    "-ss",
    String((shotStart(navigationShots[0]) - 1) / fps),
    "-i",
    masterPath,
    "-t",
    String(boundaryDuration),
    "-an",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    "slow",
    "-pix_fmt",
    "yuv420p",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-movflags",
    "+faststart",
    boundary.source,
  ],
  "render assistant-to-knowledge boundary"
);

for (const item of [
  [poster.source, 1920, 1080],
  [fullSheet.source, 1920, 1260],
  [previewSheet.source, 1920, 1260],
  [contactSheet.source, 1920, 864],
  [flipSheet.source, 1920, 864],
  [fullPreviewFlips.source, 1920, 864],
  [firstNavigationSheet.source, 1920, 810],
  [navigationSheet.source, 1920, 810],
  [sampleSheet.source, 1920, 864],
])
  assertImage(...item);

const boundaryMetadata = probe(boundary.source);
const boundaryVideo = boundaryMetadata.streams.find(
  (stream) => stream.codec_type === "video"
);
if (
  !boundaryVideo ||
  boundaryVideo.width !== 1920 ||
  boundaryVideo.height !== 1080 ||
  Math.abs(Number(boundaryMetadata.format.duration) - boundaryDuration) > 0.05
)
  throw new Error("assistant-to-knowledge boundary metadata is invalid");

const checksumRelativePaths = [
  "audio/skybao-mix.wav",
  "build-manifest.json",
  "cursor/cursor.png",
  "deliverables/build-manifest-final.json",
  "deliverables/build-manifest-preview.json",
  "deliverables/render-report-final.json",
  "deliverables/render-report-preview.json",
  "deliverables/skybao-40s-master.mp4",
  "deliverables/skybao-40s-preview.mp4",
  "provenance/skybao-ui-catalog-rendered-v3.json",
  "provenance/skybao-ui-checksums-rendered-v3.sha256",
  ...stagedByTarget.keys(),
  "skybao-film.blend",
  "skybao-film.blend1",
  "skybao-film-final.blend",
  "skybao-film-preview.blend",
]
  .filter((relative, index, all) => all.indexOf(relative) === index)
  .filter((relative) =>
    fs.existsSync(
      stagedByTarget.get(relative) || path.join(artifactRoot, relative)
    )
  )
  .sort();
const checksums = staged("checksums.sha256");
const checksumBody = checksumRelativePaths
  .map((relative) => {
    const file =
      stagedByTarget.get(relative) || path.join(artifactRoot, relative);
    return `${sha256(file)}  ${relative}`;
  })
  .join("\n");
fs.writeFileSync(checksums.source, `${checksumBody}\n`);

promoteWithRollback(
  [...stagedByTarget.entries()].map(([relative, source]) => ({
    source,
    target: path.join(artifactRoot, relative),
  })),
  stage
);
fs.rmSync(stage, { recursive: true, force: true });

console.log("SkyBao final handoff ready");
console.log(`  poster:    ${path.relative(repo, poster.target)}`);
console.log(`  contacts:  ${path.relative(repo, reviewRoot)}`);
console.log(`  checksums: ${path.relative(repo, checksums.target)}`);
