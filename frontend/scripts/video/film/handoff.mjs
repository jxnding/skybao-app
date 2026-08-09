#!/usr/bin/env node
"use strict";

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { assertCurrentProfileManifest, assertCurrentRenderReport, assertFullPackageReceipt, assertManifestInputsCurrent, assertReviewPackageReceipt, assertTargetedReviewReceipt, inputFingerprint, sha256, sha256Json } from "./provenance.mjs";

const executingHere = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const repoIndex = args.indexOf("--repo");
const repo = path.resolve(repoIndex >= 0 ? args[repoIndex + 1] || "" : path.resolve(executingHere, "../../../.."));
if (!fs.existsSync(repo)) throw new Error(`repository does not exist: ${repo}`);
const here = path.join(repo, "frontend", "scripts", "video", "film");
const artifactRoot = path.join(repo, "artifacts", "skybao-film");
const deliverableRoot = path.join(artifactRoot, "deliverables");
const reviewRoot = path.join(artifactRoot, "review", "targeted");
const receiptPath = path.join(artifactRoot, "provenance", "targeted-review-receipt.json");
const packageReceiptPath = path.join(artifactRoot, "provenance", "review-package-receipt.json");
const fullReceiptPath = path.join(artifactRoot, "provenance", "full-package-receipt.json");
const reviewReelPath = path.join(artifactRoot, "review", "skybao-targeted-review-reel.mp4");
const reviewContactSheetPath = path.join(artifactRoot, "review", "skybao-targeted-review-contact-sheet.png");
const reviewBlendPath = path.join(artifactRoot, "skybao-film-review.blend");
const reviewManifestPath = path.join(artifactRoot, "provenance", "targeted-review-build-manifest.json");
const reviewAudioPath = path.join(artifactRoot, "audio", "targeted-review-mix.wav");
const stagingRoot = path.join(repo, "artifacts", ".skybao-film-staging");
const masterPath = path.join(deliverableRoot, "skybao-40s-master.mp4");
const previewPath = path.join(deliverableRoot, "skybao-40s-preview.mp4");
const reviewOnly = args.includes("--review-only");
const unknown = args.filter((arg, index) =>
  arg !== "--review-only" && arg !== "--repo" && index !== repoIndex + 1
);
if (unknown.length) throw new Error(`unknown handoff option: ${unknown.join(", ")}`);
const shotlist = JSON.parse(
  fs.readFileSync(path.join(here, "shotlist.json"), "utf8")
);
const fps = shotlist.format?.fps || 30;
const totalFrames = shotlist.format?.frames || 1200;
const canonicalFrames = shotlist.targetedReviewFrames;

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
const blender = commandFrom(
  ["/Applications/Blender.app/Contents/MacOS/Blender", "blender"],
  "BLENDER_BIN"
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

function checkUsedCaptures() {
  const ids = [...new Set(shotlist.shots.map((shot) => shot.source?.id).filter(Boolean))];
  if (ids.length !== 19) throw new Error(`shotlist must reference 19 capture owners (found ${ids.length})`);
  const captureScript = path.join(repo, "frontend", "scripts", "video", "capture-skybao-assets.mjs");
  const result = spawnSync(process.execPath, [captureScript, "--check", `--only=${ids.join(",")}`], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stderr || ""}\n${result.stdout || ""}`;
    const summary = output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /Stale capture recipe or content|Error summary|Error:/.test(line) && !/^at /.test(line));
    const details = summary || output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("at "))
      .join(" ");
    throw new Error(`handoff rejected: used capture freshness check failed${details ? ` (${details})` : ""}`);
  }
}

function requireCanonicalReview() {
  if (!Array.isArray(canonicalFrames) || !canonicalFrames.length) throw new Error("shotlist has no canonical targeted review set");
  if (!fs.existsSync(receiptPath)) throw new Error("canonical targeted review receipt is required");
   if (!fs.existsSync(reviewBlendPath)) throw new Error("dedicated targeted review blend is required");
  for (const file of [
     reviewAudioPath,
    path.join(artifactRoot, "cursor", "cursor.png"),
     reviewManifestPath,
  ]) {
    if (!fs.existsSync(file)) throw new Error(`required review artifact is missing: ${path.relative(repo, file)}`);
  }
  let receipt; try { receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")); } catch { throw new Error("canonical targeted review receipt is invalid"); }
  try { assertTargetedReviewReceipt(receipt); } catch (error) { throw new Error(`canonical targeted review receipt is invalid: ${error.message}`); }
  const frames = [...canonicalFrames].sort((a, b) => a - b);
   if (JSON.stringify(Object.keys(receipt.frames || {}).map(Number).sort((a, b) => a - b)) !== JSON.stringify(frames)) throw new Error("canonical targeted review receipt frame set is stale");
  if (!fs.existsSync(reviewRoot)) throw new Error("canonical targeted review directory is required");
  const names = fs.readdirSync(reviewRoot).filter((name) => /^frame-\d{4}\.png$/.test(name)).sort();
  const expected = frames.map((frame) => `frame-${String(frame).padStart(4, "0")}.png`).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("canonical targeted review set is incomplete or contains extras");
  for (const frame of frames) {
    const file = path.join(reviewRoot, `frame-${String(frame).padStart(4, "0")}.png`);
    if (receipt.hashes?.[String(frame)] !== sha256(file)) throw new Error(`canonical targeted review hash mismatch at frame ${frame}`);
    const expectedPath = `artifacts/skybao-film/review/targeted/frame-${String(frame).padStart(4, "0")}.png`;
    if (receipt.frames?.[String(frame)]?.path !== expectedPath || receipt.frames[String(frame)].sha256 !== sha256(file)) throw new Error(`canonical targeted review receipt frame binding is stale at frame ${frame}`);
  }
  const sources = {
    shotlist: sha256(path.join(here, "shotlist.json")),
    environment: sha256(path.join(here, "environment.json")),
    catalog: sha256(path.join(repo, "artifacts", "skybao-ui", "catalog.json")),
     scene: sha256Json(JSON.parse(fs.readFileSync(reviewManifestPath, "utf8")).scene),
  };
  if (JSON.stringify(receipt.provenance) !== JSON.stringify(sources)) throw new Error("canonical targeted review receipt provenance is stale");
   const manifest = JSON.parse(fs.readFileSync(reviewManifestPath, "utf8"));
   if (manifest.audio?.path !== "artifacts/skybao-film/audio/targeted-review-mix.wav") throw new Error("canonical review manifest audio path is not self-contained");
   assertManifestInputsCurrent(manifest, { repo, audioFile: reviewAudioPath });
  if (receipt.inputFingerprint !== inputFingerprint(manifest)) throw new Error("canonical targeted review receipt input fingerprint is stale");
   const canonicalArtifacts = receipt.reviewArtifacts;
  const expectedArtifacts = {
     blend: "artifacts/skybao-film/skybao-film-review.blend",
     manifest: "artifacts/skybao-film/provenance/targeted-review-build-manifest.json",
    cursor: "artifacts/skybao-film/cursor/cursor.png",
     audio: "artifacts/skybao-film/audio/targeted-review-mix.wav",
  };
  for (const [name, relative] of Object.entries(expectedArtifacts)) {
    const entry = canonicalArtifacts?.[name];
    const file = path.resolve(repo, relative);
    if (!entry || entry.path !== relative || !fs.existsSync(file) || sha256(file) !== entry.sha256)
      throw new Error(`canonical artifact integrity failed: ${relative} is missing or hash-mismatched`);
  }
  if (canonicalArtifacts.audio.sha256 !== manifest.audio?.sha256)
    throw new Error("canonical artifact integrity failed: receipt audio hash is not bound to the build manifest");
  return receipt;
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
      "-count_frames",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,color_space,color_transfer,color_primaries,pix_fmt,r_frame_rate,nb_read_frames",
      "-of",
      "json",
      file,
    ],
    `probe ${path.basename(file)}`,
    true
  );
  return JSON.parse(result.stdout);
}

function reviewPackageReceipt() {
  if (!fs.existsSync(packageReceiptPath)) throw new Error("review package receipt is missing");
  let value;
  try { value = JSON.parse(fs.readFileSync(packageReceiptPath, "utf8")); } catch { throw new Error("review package receipt is invalid"); }
  try { assertReviewPackageReceipt(value, { expectedFrames: canonicalFrames }); } catch (error) { throw new Error(`review package receipt is invalid: ${error.message}`); }
  if (value.targetedReviewReceipt.sha256 !== sha256(receiptPath) || value.targetedReviewReceipt.inputFingerprint !== receipt.inputFingerprint)
    throw new Error("review package receipt is not bound to the current targeted receipt");
  for (const [name, file] of [["reel", reviewReelPath], ["contactSheet", reviewContactSheetPath]]) {
    const artifact = value.artifacts[name];
    if (artifact.path !== path.relative(repo, file) || !fs.existsSync(file) || artifact.sha256 !== sha256(file)) throw new Error(`review package ${name} is missing or hash-mismatched`);
    const metadata = probe(file);
    const stream = metadata.streams?.find((entry) => entry.codec_type === "video");
    if (!stream || stream.width !== artifact.metadata.width || stream.height !== artifact.metadata.height) throw new Error(`review package ${name} metadata is stale`);
    if (name === "reel" && (stream.codec_name !== artifact.metadata.codec || stream.pix_fmt !== artifact.metadata.pixFmt || stream.r_frame_rate !== "30/1" || Number(stream.nb_read_frames) !== artifact.metadata.frameCount || Math.abs(Number(metadata.format.duration) - artifact.metadata.duration) > 0.01)) throw new Error("review package reel metadata is stale");
  }
  return value;
}

function assertImage(file, width, height) {
  const metadata = probe(file);
  const video = metadata.streams.find(
    (stream) => stream.codec_type === "video"
  );
  if (!video || video.width !== width || video.height !== height)
    throw new Error(`${file} is not ${width}x${height}`);
}

function assertReportAssets(report, profile, manifest, videoPath, blendPath, mixPath, manifestPath) {
  const expected = {
    mode: profile,
    video: path.relative(repo, videoPath),
    blend: path.relative(repo, blendPath),
    mix: path.relative(repo, mixPath),
    buildManifest: path.relative(repo, manifestPath),
  };
  if (report.mode !== expected.mode || report.render?.cycles?.profile !== expected.mode)
    throw new Error(`full handoff rejected: ${profile} report has the wrong mode/profile`);
  for (const [name, relative] of Object.entries(expected).filter(([name]) => name !== "mode")) {
    if (report.files?.[name] !== relative)
      throw new Error(`full handoff rejected: ${profile} report has the wrong ${name} path`);
  }
  const files = { video: videoPath, blend: blendPath, mix: mixPath, buildManifest: manifestPath };
  for (const [name, file] of Object.entries(files)) {
    if (!fs.existsSync(file) || report.sha256?.[name] !== sha256(file))
      throw new Error(`full handoff rejected: ${profile} report ${name} checksum does not match the bound file`);
  }
  const manifestHash = sha256(manifestPath);
  if (report.provenance?.buildManifest?.path !== expected.buildManifest ||
      report.provenance?.buildManifest?.sha256 !== manifestHash ||
      report.sha256.buildManifest !== manifestHash)
    throw new Error(`full handoff rejected: ${profile} report build manifest checksum is inconsistent`);
  if (manifest.artifacts?.blend?.sha256 !== sha256(blendPath))
    throw new Error(`full handoff rejected: ${profile} manifest blend checksum does not match the bound blend`);
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

// Handoff is a consumer boundary too: never issue a receipt or promote checksums
// from a catalog whose referenced PNGs changed underneath it.
checkUsedCaptures();
const receipt = requireCanonicalReview();
if (!reviewOnly) reviewPackageReceipt();
run(
  blender,
   ["--background", reviewBlendPath, "--python", path.join(here, "scene-contract.py"), "--",
     "--repo", repo, "--manifest", reviewManifestPath, "--audio", reviewAudioPath],
  "canonical saved scene contract"
);
if (!reviewOnly) {
  if (!fs.existsSync(masterPath) || !fs.existsSync(previewPath)) throw new Error("full handoff requires both current final and preview MP4s");
  const fingerprint = receipt.inputFingerprint;
  const manifests = new Map();
  for (const file of ["deliverables/build-manifest-preview.json", "deliverables/build-manifest-final.json"]) {
    const full = path.join(artifactRoot, file);
    if (!fs.existsSync(full)) throw new Error(`full handoff requires ${file}`);
    let value; try { value = JSON.parse(fs.readFileSync(full, "utf8")); } catch { value = null; }
    try { assertCurrentProfileManifest(value, fingerprint); } catch { throw new Error(`full handoff rejected: ${file} is not a current profile manifest (stale v3 deliverable)`); }
    manifests.set(file.includes("preview") ? "preview" : "final", value);
  }
  for (const file of ["deliverables/render-report-preview.json", "deliverables/render-report-final.json"]) {
    const full = path.join(artifactRoot, file);
    if (!fs.existsSync(full)) throw new Error(`full handoff requires ${file}`);
    let value; try { value = JSON.parse(fs.readFileSync(full, "utf8")); } catch { value = null; }
    const profile = file.includes("preview") ? "preview" : "final";
    const manifest = manifests.get(profile);
    try {
      assertCurrentRenderReport(value, fingerprint, sha256(path.join(deliverableRoot, `build-manifest-${profile}.json`)));
      assertReportAssets(value, profile, manifest,
        profile === "final" ? masterPath : previewPath,
        path.join(artifactRoot, `skybao-film-${profile}.blend`),
        path.join(artifactRoot, "audio", "skybao-mix.wav"),
        path.join(deliverableRoot, `build-manifest-${profile}.json`));
    } catch (error) { throw new Error(`full handoff rejected: ${file} is not bound to the current ${profile} profile manifest: ${error.message}`); }
  }
  for (const file of ["skybao-film-preview.blend", "skybao-film-final.blend"]) {
    const full = path.join(artifactRoot, file);
    const sidecar = path.join(artifactRoot, "deliverables", `build-manifest-${file.includes("preview") ? "preview" : "final"}.json`);
    if (!fs.existsSync(full) || !fs.existsSync(sidecar)) throw new Error(`full handoff requires current ${file} and its companion manifest`);
    const value = manifests.get(file.includes("preview") ? "preview" : "final");
    if (value.inputFingerprint !== fingerprint || value.artifacts?.blend?.sha256 !== sha256(full)) throw new Error(`full handoff rejected: ${file} is stale or not bound to its companion manifest`);
  }
}

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

let poster = null;
let reviewReel = null;
if (reviewOnly) {
  reviewReel = staged("review/skybao-targeted-review-reel.mp4");
  const reviewSheet = staged("review/skybao-targeted-review-contact-sheet.png");
  const concatList = path.join(stage, "targeted-review-reel.txt");
  const entries = canonicalFrames.map((frame) => {
    const file = path.join(reviewRoot, `frame-${String(frame).padStart(4, "0")}.png`);
    return `file '${file.replaceAll("'", "'\\''")}'\nduration 0.5`;
  });
  entries.push(entries.at(-1).split("\nduration")[0]);
  fs.writeFileSync(concatList, `${entries.join("\n")}\n`);
  run(ffmpeg, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", concatList,
    "-t", "8", "-frames:v", "240", "-r", String(fps), "-c:v", "libx264", "-crf", "18", "-preset", "medium",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", reviewReel.source],
  "generate targeted checkpoint reel");
  const reelVideo = probe(reviewReel.source).streams.find((stream) => stream.codec_type === "video");
  const reelProbe = probe(reviewReel.source);
  if (!reelVideo || reelVideo.width !== 1920 || reelVideo.height !== 1080 ||
      reelVideo.codec_name !== "h264" || reelVideo.pix_fmt !== "yuv420p" ||
      reelVideo.r_frame_rate !== "30/1" || Number(reelVideo.nb_read_frames) !== 240 ||
      Math.abs(Number(reelProbe.format.duration) - 8) > 0.001)
    throw new Error("targeted checkpoint reel metadata is invalid");
  run(ffmpeg, ["-v", "error", "-y", "-i", reviewReel.source, "-vf", "fps=2,scale=480:270:flags=lanczos,tile=4x4:nb_frames=16", "-frames:v", "1", reviewSheet.source], "generate targeted contact sheet");
  assertImage(reviewSheet.source, 1920, 1080);
  const reelMetadata = probe(reviewReel.source);
  const reelStream = reelMetadata.streams.find((stream) => stream.codec_type === "video");
  const sheetMetadata = probe(reviewSheet.source);
  const sheetStream = sheetMetadata.streams.find((stream) => stream.codec_type === "video");
  const packageReceipt = staged("provenance/review-package-receipt.json");
  fs.writeFileSync(packageReceipt.source, JSON.stringify({
      schemaVersion: 2,
      targetedReviewReceipt: { path: path.relative(repo, receiptPath), sha256: sha256(receiptPath), inputFingerprint: receipt.inputFingerprint },
      sourceFrames: { count: canonicalFrames.length, order: canonicalFrames, orderDigest: sha256Json(canonicalFrames) },
      artifacts: {
       reel: { path: path.relative(repo, reviewReel.target), sha256: sha256(reviewReel.source), metadata: { width: reelStream.width, height: reelStream.height, codec: reelStream.codec_name, pixFmt: reelStream.pix_fmt, fps: 30, duration: 8, frameCount: 240 } },
       contactSheet: { path: path.relative(repo, reviewSheet.target), sha256: sha256(reviewSheet.source), metadata: { width: sheetStream.width, height: sheetStream.height, columns: 4, rows: 4, frameCount: 16 } },
      },
    }, null, 2) + "\n");
   let generatedPackage;
   try { generatedPackage = JSON.parse(fs.readFileSync(packageReceipt.source, "utf8")); assertReviewPackageReceipt(generatedPackage, { expectedFrames: canonicalFrames }); } catch (error) { throw new Error(`generated review package receipt is invalid: ${error.message}`); }
}
if (!reviewOnly) {
const posterShot = shotlist.shots.find((shot) => shot.id === "work-board-drag");
if (!posterShot) throw new Error("shotlist is missing work-board-drag");
const posterFrame = Math.round(
  shotStart(posterShot) + (shotEnd(posterShot) - shotStart(posterShot)) * 0.73
);
poster = staged("deliverables/skybao-poster.png");
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
}

const parseChecksums = (file, label) => {
  const entries = new Map();
  if (!fs.existsSync(file)) return entries;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) throw new Error(`${label} contains an invalid checksum line`);
    if (entries.has(match[2])) throw new Error(`${label} contains a duplicate checksum path`);
    entries.set(match[2], match[1]);
  }
  return entries;
};
const requireUnchanged = (entries, label) => {
  for (const [relative, digest] of entries) {
    const file = path.join(artifactRoot, relative);
    if (!fs.existsSync(file) || sha256(file) !== digest)
      throw new Error(`${label} entry is missing or modified: ${relative}`);
  }
};
const reviewChecksumPath = path.join(artifactRoot, "checksums-review.sha256");
const fullChecksumPath = path.join(artifactRoot, "checksums-full.sha256");
const oldReview = parseChecksums(reviewChecksumPath, "checksums-review.sha256");
const oldFull = parseChecksums(fullChecksumPath, "checksums-full.sha256");
// A review-package rebuild is deliberately independent of the old review
// ledger.  In particular, a stale entry must not prevent receipt bootstrap.
// Full state, when present, is a separate authenticated package and is never
// rebuilt from an incomplete checksum file.
if (!reviewOnly) requireUnchanged(oldReview, "checksums-review.sha256");

function validateFullState() {
  if (!fs.existsSync(fullReceiptPath) || !fs.existsSync(fullChecksumPath)) return null;
  let fullReceipt;
  try { fullReceipt = JSON.parse(fs.readFileSync(fullReceiptPath, "utf8")); assertFullPackageReceipt(fullReceipt); }
  catch (error) { throw new Error(`checksums-full package receipt is invalid: ${error.message}`); }
  if (fullReceipt.inputFingerprint !== receipt.inputFingerprint || !fullReceipt.reviewReceipt || fullReceipt.reviewReceipt.inputFingerprint !== receipt.inputFingerprint)
    throw new Error("checksums-full package receipt fingerprint binding is invalid");
  const expected = new Map(Object.entries(fullReceipt.artifacts));
  expected.set("provenance/full-package-receipt.json", sha256(fullReceiptPath));
  const actual = parseChecksums(fullChecksumPath, "checksums-full.sha256");
  if (actual.size !== expected.size || [...expected].some(([name, digest]) => actual.get(name) !== digest))
    throw new Error("checksums-full.sha256 does not exactly match the authenticated full package receipt");
  requireUnchanged(actual, "checksums-full.sha256");
  return actual;
}

const reviewRelativePaths = [
  "audio/targeted-review-mix.wav", "provenance/targeted-review-build-manifest.json",
  "provenance/targeted-review-receipt.json", "provenance/review-package-receipt.json",
  "cursor/cursor.png", "skybao-film-review.blend",
  "review/skybao-targeted-review-reel.mp4", "review/skybao-targeted-review-contact-sheet.png",
  ...canonicalFrames.flatMap((frame) => [
    path.join("review", "targeted", `frame-${String(frame).padStart(4, "0")}.png`),
    path.join("review", `frame-${String(frame).padStart(4, "0")}.png`),
  ]),
].filter((relative, index, all) => all.indexOf(relative) === index).sort();
const fullRelativePaths = [
  "audio/skybao-mix.wav", "deliverables/build-manifest-final.json", "deliverables/build-manifest-preview.json",
  "deliverables/render-report-final.json", "deliverables/render-report-preview.json",
  "deliverables/skybao-40s-master.mp4", "deliverables/skybao-40s-preview.mp4",
  "skybao-film-final.blend", "skybao-film-preview.blend",
  ...[...stagedByTarget.keys()].filter((relative) => !reviewRelativePaths.includes(relative)),
].filter((relative, index, all) => all.indexOf(relative) === index).sort();

function checksumMap(paths, old, label) {
  const result = new Map(old);
  for (const relative of paths) {
    const file = stagedByTarget.get(relative) || path.join(artifactRoot, relative);
    if (!fs.existsSync(file)) throw new Error(`${label} artifact is missing: ${relative}`);
    result.set(relative, sha256(file));
  }
  return result;
}
const reviewChecksums = checksumMap(reviewRelativePaths, reviewOnly ? new Map() : oldReview, "review");
let fullChecksums = null;
if (!reviewOnly) {
  const receiptArtifacts = new Map();
  for (const relative of fullRelativePaths) {
    const file = stagedByTarget.get(relative) || path.join(artifactRoot, relative);
    if (!fs.existsSync(file)) throw new Error(`full artifact is missing: ${relative}`);
    receiptArtifacts.set(relative, sha256(file));
  }
  const fullReceipt = {
    schemaVersion: 1,
    inputFingerprint: receipt.inputFingerprint,
    reviewReceipt: { path: "artifacts/skybao-film/provenance/targeted-review-receipt.json", inputFingerprint: receipt.inputFingerprint },
    artifacts: Object.fromEntries([...receiptArtifacts].sort(([a], [b]) => a.localeCompare(b))),
  };
  assertFullPackageReceipt(fullReceipt);
  const fullReceiptFile = staged("provenance/full-package-receipt.json");
  fs.writeFileSync(fullReceiptFile.source, `${JSON.stringify(fullReceipt, null, 2)}\n`);
  stagedByTarget.set("provenance/full-package-receipt.json", fullReceiptFile.source);
  receiptArtifacts.set("provenance/full-package-receipt.json", sha256(fullReceiptFile.source));
  fullChecksums = receiptArtifacts;
} else {
  fullChecksums = validateFullState();
}
const writeChecksum = (relative, entries) => {
  const output = staged(relative);
  fs.writeFileSync(output.source, `${[...entries].sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${digest}  ${name}`).join("\n")}\n`);
  return output;
};
const reviewChecksumsFile = writeChecksum("checksums-review.sha256", reviewChecksums);
const fullChecksumsFile = fullChecksums
   ? writeChecksum("checksums-full.sha256", fullChecksums)
   : null;
const aggregate = new Map([...(fullChecksums || []), ...reviewChecksums]);
const aggregateFile = writeChecksum("checksums.sha256", aggregate);

function verifyChecksumSet(file, expected, label) {
  const actual = parseChecksums(file, label);
  if (actual.size !== expected.size || [...expected].some(([name, digest]) => actual.get(name) !== digest))
    throw new Error(`${label} does not match the generated mode-specific set`);
  requireUnchanged(actual, label);
}

promoteWithRollback(
  [...stagedByTarget.entries()].map(([relative, source]) => ({
    source,
    target: path.join(artifactRoot, relative),
  })),
  stage
);
fs.rmSync(stage, { recursive: true, force: true });

// Bootstrap intentionally permits an absent package receipt.  Once the reel,
// sheet, and receipt have been promoted, run the same completed-package gate
// used by full handoff rather than trusting staged JSON alone.
if (reviewOnly) reviewPackageReceipt();
verifyChecksumSet(reviewChecksumPath, reviewChecksums, "checksums-review.sha256");
if (fullChecksumsFile) verifyChecksumSet(fullChecksumPath, fullChecksums, "checksums-full.sha256");
verifyChecksumSet(path.join(artifactRoot, "checksums.sha256"), aggregate, "checksums.sha256");

console.log(reviewOnly ? "SkyBao review-only handoff ready (old v3 deliverables deferred)" : "SkyBao final handoff ready");
if (!reviewOnly) {
  console.log(`  poster:    ${path.relative(repo, poster.target)}`);
  console.log(`  contacts:  ${path.relative(repo, reviewRoot)}`);
}
console.log(`  checksums: ${path.relative(repo, aggregateFile.target)}`);
