#!/usr/bin/env node
// Validate the SkyBao film shotlist + inputs before editing.
// Checks: exact 1200 frames, contiguous shots, clip trims within catalog
// frame counts, required PNGs present, and optional WAV metadata.
"use strict";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FILM_DIR = __dirname;
const SHOTLIST_PATH = path.join(FILM_DIR, "shotlist.json");
const CATALOG_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "artifacts",
  "skybao-ui",
  "catalog.json"
);
const UI_ROOT = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "artifacts",
  "skybao-ui"
);
const FILM_ROOT = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "artifacts",
  "skybao-film"
);

const errors = [];
const warnings = [];
const ok = (m) => console.log(`  ok    ${m}`);
const fail = (m) => errors.push(m);

// ---- shotlist parsing ----
if (!fs.existsSync(SHOTLIST_PATH)) {
  console.error(`error: missing shotlist.json at ${SHOTLIST_PATH}`);
  process.exit(1);
}
const shotlist = JSON.parse(fs.readFileSync(SHOTLIST_PATH, "utf8"));
const shots = shotlist.shots;
const FPS = shotlist.format?.fps ?? 30;
const EXPECTED_FRAMES = shotlist.format?.frames ?? 1200;
const EXPECTED_END = EXPECTED_FRAMES;

console.log("SkyBao film · validate");
console.log(`  shotlist: ${SHOTLIST_PATH}`);
console.log(
  `  expected: ${EXPECTED_FRAMES} frames @ ${FPS}fps (${shotlist.shotCount} shots)`
);

// ---- exact frame count & continuity ----
let cursor = 1;
shots.forEach((shot, i) => {
  const { start, end, count } = shot.frames;
  const expectedCount = end - start + 1;
  if (count !== expectedCount) {
    fail(
      `shot ${shot.number}: count ${count} does not match frames ${start}-${end} (${expectedCount})`
    );
  }
  if (start !== cursor) {
    fail(
      `shot ${shot.number}: starts at frame ${start}, expected ${cursor} (gap or overlap)`
    );
  }
  cursor = end + 1;
  if (start < 1 || end > EXPECTED_END) {
    fail(
      `shot ${shot.number}: frames ${start}-${end} outside 1..${EXPECTED_END}`
    );
  }
});
if (cursor !== EXPECTED_END + 1) {
  fail(`shots cover ${cursor - 1} frames, expected ${EXPECTED_FRAMES}`);
} else {
  ok(`exactly ${EXPECTED_FRAMES} frames, contiguous 1..${EXPECTED_END}`);
}
if (shots.length !== shotlist.shotCount) {
  fail(`shotCount ${shotlist.shotCount} != actual shots ${shots.length}`);
} else {
  ok(`${shots.length} shots listed`);
}

// ---- catalog ----
if (!fs.existsSync(CATALOG_PATH)) {
  console.error(`error: missing catalog.json at ${CATALOG_PATH}`);
  process.exit(1);
}
const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
const settings = catalog.settings;
const assets = catalog.assets;

// group catalog entries by (id, framing)
const byId = new Map();
for (const a of assets) {
  const k = `${a.type}:${a.id}`;
  if (!byId.has(k)) byId.set(k, []);
  byId.get(k).push(a);
}

const frameName = (n) => `frame-${String(n).padStart(6, "0")}.png`;

for (const shot of shots) {
  const src = shot.source;
  if (src.type === "still") {
    const entries = byId.get(`still:${src.id}`) || [];
    const entry = entries.find((e) => e.framing === src.framing) || entries[0];
    if (!entry) {
      fail(
        `shot ${shot.number}: still "${src.id}" (${src.framing}) not in catalog`
      );
      continue;
    }
    const file = path.join(UI_ROOT, entry.file);
    if (!fs.existsSync(file)) {
      fail(`shot ${shot.number}: still PNG missing: ${entry.file}`);
    } else {
      ok(`shot ${shot.number}: still ${src.id} ${entry.file}`);
    }
  } else if (src.type === "clip") {
    const entries = byId.get(`clip:${src.id}`) || [];
    const entry = entries.find((e) => e.framing === src.framing) || entries[0];
    if (!entry) {
      fail(
        `shot ${shot.number}: clip "${src.id}" (${src.framing}) not in catalog`
      );
      continue;
    }
    const dir = path.join(UI_ROOT, entry.directory);
    const total = entry.frameCount ?? entry.capturedFrames ?? entry.frameCount;
    const { startFrame, endFrame } = src;
    const want = shot.frames.count;
    const actual = endFrame - startFrame + 1;
    if (startFrame < 1) fail(`shot ${shot.number}: trim start < 1`);
    if (endFrame > total)
      fail(`shot ${shot.number}: trim end ${endFrame} > clip frames ${total}`);
    if (actual !== want) {
      fail(
        `shot ${shot.number}: trim ${startFrame}-${endFrame} (${actual} frames) != shot ${want} frames`
      );
    }
    // verify start/end PNGs exist
    for (const f of [startFrame, endFrame]) {
      const p = path.join(dir, frameName(f));
      if (!fs.existsSync(p))
        fail(`shot ${shot.number}: missing ${entry.directory}/${frameName(f)}`);
    }
    if (fs.existsSync(path.join(dir, frameName(startFrame)))) {
      ok(
        `shot ${shot.number}: clip ${src.id} trim ${startFrame}-${endFrame} (of ${total}) PNGs present`
      );
    }
  } else {
    fail(`shot ${shot.number}: unknown source type "${src.type}"`);
  }

  // camera sanity
  const cam = shot.camera;
  if (cam?.start?.scale > 0 && cam?.end?.scale > 0) {
    if (
      Math.abs(cam.start.scale - cam.end.scale) < 1e-6 &&
      (cam.start.x !== cam.end.x || cam.start.y !== cam.end.y)
    ) {
      // fine, a pan
    }
  } else {
    fail(`shot ${shot.number}: camera missing start/end scale`);
  }
  if (!Array.isArray(shot.sfxCues))
    fail(`shot ${shot.number}: missing sfxCues array`);
}

// ---- optional WAV metadata check ----
const wavPath = path.join(FILM_ROOT, "audio", "skybao-mix.wav");
if (fs.existsSync(wavPath)) {
  const buf = fs.readFileSync(wavPath);
  const parse = () => {
    if (buf.length < 44) return null;
    if (
      buf.toString("ascii", 0, 4) !== "RIFF" ||
      buf.toString("ascii", 8, 12) !== "WAVE"
    )
      return null;
    const fmtOff = 16; // "fmt " payload begins here
    const audioFormat = buf.readUInt16LE(fmtOff + 4);
    const channels = buf.readUInt16LE(fmtOff + 6);
    const rate = buf.readUInt32LE(fmtOff + 8);
    const bits = buf.readUInt16LE(fmtOff + 18);
    const dataSize = buf.readUInt32LE(40);
    const duration = dataSize / (channels * (bits / 8)) / rate;
    return { audioFormat, channels, rate, bits, duration, dataSize };
  };
  const w = parse();
  if (!w) {
    fail(`WAV at ${wavPath} is not a valid RIFF/WAVE file`);
  } else {
    if (w.audioFormat !== 1)
      fail(`WAV audio format ${w.audioFormat} != PCM(1)`);
    if (w.channels !== 2) fail(`WAV channels ${w.channels} != 2`);
    if (w.rate !== 48000) fail(`WAV sample rate ${w.rate} != 48000`);
    if (w.bits !== 16) fail(`WAV bit depth ${w.bits} != 16`);
    const durTol = Math.abs(w.duration - 40.0);
    if (durTol > 0.01) fail(`WAV duration ${w.duration.toFixed(4)}s != 40.0s`);
    if (
      durTol <= 0.01 &&
      w.channels === 2 &&
      w.rate === 48000 &&
      w.bits === 16
    ) {
      ok(`WAV stereo / 48kHz / 16-bit / ${w.duration.toFixed(3)}s`);
    }
  }
} else {
  warnings.push(`no generated WAV yet at ${wavPath}`);
}

console.log("");
if (errors.length) {
  console.error(`FAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
for (const w of warnings) console.warn(`  warn ${w}`);
console.log("validate: PASS");
