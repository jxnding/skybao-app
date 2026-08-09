#!/usr/bin/env node
"use strict";

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { assertManifestInputsCurrent, bindManifest, inputFingerprint, sha256, sha256Json } from "./provenance.mjs";

const executingHere = path.dirname(fileURLToPath(import.meta.url));
const scriptArgs = process.argv.slice(2);
const repoIndex = scriptArgs.indexOf("--repo");
const repo = path.resolve(repoIndex >= 0 ? scriptArgs[repoIndex + 1] || "" : path.resolve(executingHere, "../../../.."));
if (!fs.existsSync(repo)) throw new Error(`repository does not exist: ${repo}`);
const here = path.join(repo, "frontend", "scripts", "video", "film");
if (repoIndex >= 0 && fs.realpathSync(executingHere) !== fs.realpathSync(path.join(here, "render.mjs")))
  console.warn("render: alternate repository consumers selected");
const artifactRoot = path.join(repo, "artifacts", "skybao-film");
const blendPath = path.join(artifactRoot, "skybao-film.blend");
const audioPath = path.join(artifactRoot, "audio", "skybao-mix.wav");
const deliverableRoot = path.join(artifactRoot, "deliverables");
const buildManifestPath = path.join(artifactRoot, "build-manifest.json");
const targetedReceiptPath = path.join(artifactRoot, "provenance", "targeted-review-receipt.json");
const reviewBlendPath = path.join(artifactRoot, "skybao-film-review.blend");
const reviewManifestPath = path.join(artifactRoot, "provenance", "targeted-review-build-manifest.json");
const reviewAudioPath = path.join(artifactRoot, "audio", "targeted-review-mix.wav");
const reviewRoot = path.join(artifactRoot, "review", "targeted");
// Kept beside, rather than inside, the committed film artifact directory. The
// private .gitignore makes interrupted render work invisible to Git while
// leaving it available for diagnosis or manual cleanup.
const stagingRoot = path.join(repo, "artifacts", ".skybao-film-staging");
const shotlistPath = path.join(here, "shotlist.json");
const captureScript = path.join(
  repo,
  "frontend",
  "scripts",
  "video",
  "capture-skybao-assets.mjs"
);
const startedAt = process.hrtime.bigint();

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
  yarn video:film --samples=targeted Render canonical recipe review frames
  yarn video:film --samples=30,241 Render ad-hoc review frames
  yarn video:film --shots=assistant-research,work-board-drag
  yarn video:film --check          Validate manifests, inputs, and Cycles device without writing

Options:
  --cycles-device=auto|metal|cpu   Cycles render device (default: auto)
  --keep-frames                    Promote validated PNG intermediates after a successful render
  BLENDER_BIN=/path/to/blender     Override Blender executable
  FFMPEG_BIN=/path/to/ffmpeg       Override FFmpeg executable
  FFPROBE_BIN=/path/to/ffprobe     Override FFprobe executable`);
}

if (has("--help") || has("-h")) {
  usage();
  process.exit(0);
}

const samplesArg = scriptArgs.find((arg) => arg.startsWith("--samples="));
const shotsArg = scriptArgs.find((arg) => arg.startsWith("--shots="));
const cyclesDeviceArg = scriptArgs.find((arg) =>
  arg.startsWith("--cycles-device=")
);
const cyclesDevice = cyclesDeviceArg?.split("=", 2)[1] || "auto";
if (!new Set(["auto", "metal", "cpu"]).has(cyclesDevice))
  throw new Error(
    `--cycles-device must be auto, metal, or cpu; received ${cyclesDevice}`
  );

function parseSampleFrames(argument) {
  if (!argument) return null;
  const raw = argument.split("=", 2)[1];
  if (raw === "targeted") return "targeted";
  const values = raw.split(",");
  if (values.length === 0 || values.some((value) => !/^\d+$/.test(value)))
    throw new Error(
      "--samples must be a comma-separated list of frame indices"
    );
  const frames = values.map(Number);
  if (frames.some((frame) => frame < 1 || frame > 1200))
    throw new Error("--samples frame indices must be within 1..1200");
  return [...new Set(frames)].sort((a, b) => a - b);
}

const sampleFrames = parseSampleFrames(samplesArg);
const targetedReview = Boolean(samplesArg || shotsArg);
const canonicalTargeted = sampleFrames === "targeted";
const recipe = JSON.parse(fs.readFileSync(shotlistPath, "utf8"));
const canonicalFrames = recipe.targetedReviewFrames;
if (canonicalTargeted && (!Array.isArray(canonicalFrames) || canonicalFrames.length === 0 ||
  canonicalFrames.some((frame) => !Number.isInteger(frame) || frame < 1 || frame > (recipe.format?.frames || 1200)) ||
  new Set(canonicalFrames).size !== canonicalFrames.length))
  throw new Error("shotlist.targetedReviewFrames must be unique bounded integer frames");
const modeFlags = ["--preview", "--final", "--build-only", "--check"].filter(
  has
);
if (modeFlags.length > 1) {
  throw new Error(`choose one render mode, received: ${modeFlags.join(", ")}`);
}
if (targetedReview && modeFlags.length)
  throw new Error("--samples/--shots cannot be combined with a render mode");
const mode = has("--check")
  ? "check"
  : targetedReview
    ? "review"
    : has("--final")
      ? "final"
      : has("--build-only")
        ? "build-only"
        : "preview";
const keepFrames = has("--keep-frames");
const strictProvenance = has("--strict-provenance");
const unknown = scriptArgs.filter(
  (arg) =>
    ![
      "--preview",
      "--final",
      "--build-only",
      "--check",
      "--keep-frames",
      "--strict-provenance",
      "--repo",
    ].includes(arg) &&
    !arg.startsWith("--samples=") &&
    !arg.startsWith("--shots=") &&
    !arg.startsWith("--cycles-device=")
    && arg !== "--repo"
    && arg !== (repoIndex >= 0 ? scriptArgs[repoIndex + 1] : null)
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
const ffmpeg = ["build-only", "review", "check"].includes(mode)
  ? null
  : commandFrom(
      ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"],
      "FFMPEG_BIN"
    );
const ffprobe = ["build-only", "review", "check"].includes(mode)
  ? null
  : commandFrom(
      ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "ffprobe"],
      "FFPROBE_BIN"
    );

function run(command, args, label, options = {}) {
  console.log(`\n[${label}]`);
  const startedAt = process.hrtime.bigint();
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
  return {
    ...result,
    elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
  };
}

function reviewReceipt() {
  if (!exists(targetedReceiptPath)) throw new Error("canonical targeted review receipt is missing; run --samples=targeted first");
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(targetedReceiptPath, "utf8")); } catch { throw new Error("canonical targeted review receipt is invalid"); }
  const expected = [...canonicalFrames].sort((a, b) => a - b);
  if (JSON.stringify(Object.keys(receipt.frames || {}).map(Number).sort((a, b) => a - b)) !== JSON.stringify(expected)) throw new Error("canonical targeted review receipt frame set is stale");
  if (!exists(reviewBlendPath) || !exists(reviewManifestPath) || !exists(reviewAudioPath))
    throw new Error("targeted review package is incomplete; rebuild --samples=targeted");
  const names = fs.readdirSync(reviewRoot).filter((name) => /^frame-\d{4}\.png$/.test(name)).sort();
  const expectedNames = expected.map((frame) => `frame-${String(frame).padStart(4, "0")}.png`).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error("canonical targeted review PNG set is incomplete or has extras");
  for (const frame of expected) {
    const file = path.join(reviewRoot, `frame-${String(frame).padStart(4, "0")}.png`);
    if (receipt.hashes?.[String(frame)] !== sha256(file)) throw new Error(`canonical targeted review hash mismatch at frame ${frame}`);
  }
  const manifest = JSON.parse(fs.readFileSync(reviewManifestPath, "utf8"));
  assertManifestInputsCurrent(manifest, { repo, audioFile: reviewAudioPath });
  const sources = {
    shotlist: sha256(shotlistPath),
    environment: sha256(path.join(here, "environment.json")),
    catalog: sha256(path.join(repo, "artifacts", "skybao-ui", "catalog.json")),
    scene: sha256Json(manifest.scene),
  };
  if (JSON.stringify(receipt.provenance) !== JSON.stringify(sources)) throw new Error("canonical targeted review receipt provenance is stale");
  if (receipt.inputFingerprint !== inputFingerprint(manifest)) throw new Error("canonical targeted review receipt input fingerprint is stale");
  const artifacts = receipt.reviewArtifacts;
  const expectedArtifacts = {
    blend: ["artifacts/skybao-film/skybao-film-review.blend", reviewBlendPath],
    manifest: ["artifacts/skybao-film/provenance/targeted-review-build-manifest.json", reviewManifestPath],
    cursor: ["artifacts/skybao-film/cursor/cursor.png", path.join(artifactRoot, "cursor", "cursor.png")],
    audio: ["artifacts/skybao-film/audio/targeted-review-mix.wav", reviewAudioPath],
  };
  for (const [name, [relative, file]] of Object.entries(expectedArtifacts))
    if (artifacts?.[name]?.path !== relative || !exists(file) || artifacts[name].sha256 !== sha256(file))
      throw new Error(`targeted review artifact hash mismatch: ${relative}`);
  for (const frame of expected) {
    const relative = path.join("artifacts/skybao-film/review/targeted", `frame-${String(frame).padStart(4, "0")}.png`);
    if (receipt.frames?.[String(frame)]?.path !== relative || receipt.frames[String(frame)].sha256 !== receipt.hashes?.[String(frame)])
      throw new Error(`targeted review receipt frame binding is stale at frame ${frame}`);
  }
  return receipt;
}

function createStage(mode) {
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.writeFileSync(path.join(stagingRoot, ".gitignore"), "*\n");
  return fs.mkdtempSync(path.join(stagingRoot, `${mode}-`));
}

function exists(file) {
  return fs.existsSync(file);
}

function promoteWithRollback(items, stage) {
  const backupRoot = path.join(stage, "rollback");
  const moved = [];
  try {
    for (const item of items) {
      if (!item.remove && !exists(item.source))
        throw new Error(`Cannot promote missing staged output: ${item.source}`);
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      const backup = path.join(
        backupRoot,
        `${moved.length}-${path.basename(item.target)}`
      );
      if (exists(item.target)) {
        fs.mkdirSync(backupRoot, { recursive: true });
        fs.renameSync(item.target, backup);
      }
      if (!item.remove) {
        try {
          fs.renameSync(item.source, item.target);
        } catch (error) {
          if (exists(backup)) fs.renameSync(backup, item.target);
          throw error;
        }
      }
      moved.push({ ...item, backup: exists(backup) ? backup : null });
    }
  } catch (error) {
    for (const item of moved.reverse()) {
      if (exists(item.target))
        fs.rmSync(item.target, { recursive: true, force: true });
      if (item.backup && exists(item.backup))
        fs.renameSync(item.backup, item.target);
    }
    throw error;
  }
  fs.rmSync(backupRoot, { recursive: true, force: true });
}

function discardStage(stage) {
  fs.rmSync(stage, { recursive: true, force: true });
}

function filmAssetIds() {
  const shotlist = JSON.parse(fs.readFileSync(shotlistPath, "utf8"));
  return [
    ...new Set(
      (shotlist.shots || []).map((shot) => shot.source?.id).filter(Boolean)
    ),
  ];
}

function readBuildManifest(manifestPath) {
  if (!fs.existsSync(manifestPath))
    throw new Error(`Blender did not write ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const render = manifest.render || manifest.cycles || {};
  return {
    raw: manifest,
    engine: render.engine || manifest.blender?.engine || null,
    profile: render.profile || render.quality || null,
    deviceRequested: render.deviceRequested || render.requestedDevice || null,
    deviceResolved: render.deviceResolved || render.resolvedDevice || null,
    deviceFallback: render.deviceFallback ?? null,
    computeDeviceType: render.computeDeviceType || null,
    activeDeviceIds: render.activeDeviceIds || [],
    metalRT: render.metalRT ?? null,
    samples: render.samples ?? null,
    adaptiveThreshold: render.adaptiveThreshold ?? null,
    resolutionPercentage: render.resolutionPercentage ?? null,
    seed: render.seed ?? null,
    animatedSeed: render.animatedSeed ?? null,
    persistentData: render.persistentData ?? null,
    denoise: render.denoise || null,
    bounces: render.bounces || null,
    devices: render.devices || [],
    elapsedRenderSeconds: render.elapsedRenderSeconds ?? null,
  };
}

function assertCyclesBuildManifest(buildManifest, requestedDevice) {
  if (buildManifest.engine !== "CYCLES")
    throw new Error(
      `Build manifest engine is ${buildManifest.engine || "missing"}, expected CYCLES`
    );
  if (!["auto", "metal", "cpu"].includes(buildManifest.deviceRequested))
    throw new Error(
      "Build manifest does not record a valid requested Cycles device"
    );
  if (!["metal", "cpu"].includes(buildManifest.deviceResolved))
    throw new Error(
      "Build manifest does not record a resolved Metal or CPU device"
    );
  if (!buildManifest.profile)
    throw new Error("Build manifest does not record a Cycles render profile");
  if (!Number.isInteger(buildManifest.samples) || buildManifest.samples < 1)
    throw new Error(
      "Build manifest does not record a positive Cycles sample count"
    );
  if (!buildManifest.denoise)
    throw new Error("Build manifest does not record Cycles denoise settings");
  if (!buildManifest.bounces)
    throw new Error(
      "Build manifest does not record Cycles light-path settings"
    );
  const portable = buildManifest.raw.scene?.portable_dependencies;
  if (
    !portable ||
    portable.missing !== 0 ||
    portable.images < 1 ||
    portable.sounds !== 1
  )
    throw new Error(
      "Build manifest does not prove portable image/audio dependencies"
    );
  if (
    buildManifest.deviceResolved === "metal" &&
    (buildManifest.computeDeviceType !== "METAL" ||
      buildManifest.activeDeviceIds.length === 0)
  )
    throw new Error(
      "Build manifest resolved Metal without an active Metal device ID"
    );
  if (
    !["OIDN", "OPENIMAGEDENOISE"].includes(buildManifest.denoise.type) ||
    buildManifest.denoise.useGpu !== true
  )
    throw new Error("Build manifest does not record GPU OIDN denoising");
  if (
    requestedDevice !== "auto" &&
    buildManifest.deviceRequested !== requestedDevice
  )
    throw new Error(
      `Build manifest requested ${buildManifest.deviceRequested}, expected ${requestedDevice}`
    );
}

run(
  process.execPath,
  [captureScript, "--check", `--only=${filmAssetIds().join(",")}`],
  "UI capture freshness"
);

if (mode === "check") {
  run(process.execPath, [path.join(here, "validate.mjs"), ...(strictProvenance ? ["--strict-provenance"] : [])], "source validation");
  // The approved package is intentionally independent of mutable profile artifacts.
  if (fs.existsSync(reviewBlendPath) && fs.existsSync(reviewManifestPath)) {
    try {
      run(
        blender,
        ["--background", reviewBlendPath, "--python", path.join(here, "scene-contract.py"), "--",
          "--repo", repo, "--manifest", reviewManifestPath, "--audio", reviewAudioPath],
        "targeted review scene contract"
      );
      reviewReceipt();
    } catch (error) { throw new Error(`targeted review package is stale: ${error.message}`); }
  } else throw new Error("approved targeted review package is missing; run --samples=targeted");
  run(
    blender,
    [
      "--background",
      "--factory-startup",
      "--python",
      path.join(here, "build-blender.py"),
      "--",
      "--repo",
      repo,
      "--device",
      cyclesDevice,
      "--probe-device",
    ],
    `Cycles ${cyclesDevice} device probe`
  );
  console.log("\nSkyBao film inputs are valid");
  process.exit(0);
}

run(process.execPath, [path.join(here, "validate.mjs"), ...(strictProvenance ? ["--strict-provenance"] : [])], "source validation");
if (["preview", "final"].includes(mode)) reviewReceipt();

// Do not let an incomplete render replace an approved review/master. Every
// Blender output, sequence, encode, report, and rollback copy lives here until
// its complete validation chain has succeeded.
const stage = createStage(mode);
const stagedAudioPath = path.join(stage, "audio", "skybao-mix.wav");
const stagedBlendPath = path.join(stage, "skybao-film.blend");
const stagedManifestPath = path.join(stage, "build-manifest.json");
const stagedReviewRoot = path.join(stage, "review");
const stagedReviewAudioPath = path.join(stage, "audio", "targeted-review-mix.wav");
const stagedReviewManifestPath = path.join(stage, "targeted-review-build-manifest.json");
const stagedReviewBlendPath = path.join(stage, "skybao-film-review.blend");
const stagedReviewRootDedicated = path.join(stage, "review-targeted");
const stagedFramesRoot = path.join(stage, "frames");

run(
  process.execPath,
  [path.join(here, "generate-audio.mjs"), "--out", stagedAudioPath],
  "deterministic audio"
);

const blenderArgs = [
  "--background",
  "--factory-startup",
  "--python",
  path.join(here, "build-blender.py"),
  "--",
  "--repo",
  repo,
  "--out",
  stagedBlendPath,
  "--manifest-out",
  stagedManifestPath,
  "--audio",
  stagedAudioPath,
  "--audio-canonical",
  audioPath,
  "--device",
  cyclesDevice,
];

let framesDir = null;
if (["preview", "final"].includes(mode)) {
  framesDir = stagedFramesRoot;
  blenderArgs.push("--frames-out", framesDir);
  blenderArgs.push("--quality", mode);
  blenderArgs.push("--receipt", targetedReceiptPath);
}
if (mode === "review") blenderArgs.push("--frames-out", stagedReviewRoot);
if (canonicalTargeted) blenderArgs.push("--samples", canonicalFrames.join(","));
else if (sampleFrames) blenderArgs.push("--samples", sampleFrames.join(","));
if (shotsArg) blenderArgs.push("--shots", shotsArg.split("=", 2)[1]);

const blenderRun = run(
  blender,
  blenderArgs,
  mode === "build-only"
    ? "build Blender project"
    : mode === "review"
      ? "build Blender project and review frames"
      : `render ${mode} frames`
);

if (!fs.existsSync(stagedBlendPath))
  throw new Error(`Blender did not create ${stagedBlendPath}`);
// Bind the exact source/scene inputs before any downstream validation or
// deliverable is made.  This is intentionally independent of the selected
// preview/final/sample render profile.
const boundManifest = bindManifest(JSON.parse(fs.readFileSync(stagedManifestPath, "utf8")));
fs.writeFileSync(stagedManifestPath, `${JSON.stringify(boundManifest, null, 2)}\n`);
const buildManifest = readBuildManifest(stagedManifestPath);
assertCyclesBuildManifest(buildManifest, cyclesDevice);
// Validate the manifest produced by this exact build before anything can be
// promoted.  The staged audio override is important: a newly generated mix is
// intentionally not the old canonical file until atomic promotion succeeds.
run(
  process.execPath,
  [
    path.join(here, "validate.mjs"),
    "--repo",
    repo,
    "--manifest",
    stagedManifestPath,
    "--audio",
    stagedAudioPath,
    "--strict-provenance",
  ],
  "staged provenance validation"
);
run(
  blender,
  ["--background", stagedBlendPath, "--python", path.join(here, "scene-contract.py"), "--",
    "--repo", repo, "--manifest", stagedManifestPath, "--audio", stagedAudioPath, "--allow-staged"],
  "staged scene contract"
);

if (mode === "build-only") {
  promoteWithRollback(
    [
      { source: stagedBlendPath, target: blendPath },
      { source: stagedManifestPath, target: buildManifestPath },
      { source: stagedAudioPath, target: audioPath },
    ],
    stage
  );
  discardStage(stage);
  console.log(`\nReady: ${blendPath}`);
  process.exit(0);
}
if (mode === "review") {
  if (!exists(stagedReviewRoot))
    throw new Error(`Blender did not create review output ${stagedReviewRoot}`);
  if (canonicalTargeted) {
    const actual = fs.readdirSync(stagedReviewRoot).filter((name) => /^frame-\d{4}\.png$/.test(name)).sort();
    const expected = canonicalFrames.map((frame) => `frame-${String(frame).padStart(4, "0")}.png`).sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
      throw new Error(`canonical targeted review must contain exactly ${expected.length} staged PNGs (found ${actual.length})`);
       fs.cpSync(stagedReviewRoot, stagedReviewRootDedicated, { recursive: true });
       fs.copyFileSync(stagedAudioPath, stagedReviewAudioPath);
       fs.copyFileSync(stagedManifestPath, stagedReviewManifestPath);
       fs.copyFileSync(stagedBlendPath, stagedReviewBlendPath);
       const receipt = {
        schemaVersion: 1,
      frames: [...canonicalFrames].sort((a, b) => a - b),
      hashes: Object.fromEntries(canonicalFrames.map((frame) => [String(frame), sha256(path.join(stagedReviewRoot, `frame-${String(frame).padStart(4, "0")}.png`))])),
      provenance: {
        shotlist: sha256(shotlistPath),
        environment: sha256(path.join(here, "environment.json")),
        catalog: sha256(path.join(repo, "artifacts", "skybao-ui", "catalog.json")),
        scene: sha256Json(JSON.parse(fs.readFileSync(stagedManifestPath, "utf8")).scene),
        },
        inputFingerprint: inputFingerprint(JSON.parse(fs.readFileSync(stagedManifestPath, "utf8"))),
         reviewArtifacts: {
           blend: { path: "artifacts/skybao-film/skybao-film-review.blend", sha256: sha256(stagedReviewBlendPath) },
           manifest: { path: "artifacts/skybao-film/provenance/targeted-review-build-manifest.json", sha256: sha256(stagedReviewManifestPath) },
           cursor: { path: "artifacts/skybao-film/cursor/cursor.png", sha256: sha256(path.join(artifactRoot, "cursor", "cursor.png")) },
           audio: { path: "artifacts/skybao-film/audio/targeted-review-mix.wav", sha256: sha256(stagedReviewAudioPath) },
         },
      };
     receipt.frames = Object.fromEntries(canonicalFrames.map((frame) => [String(frame), {
       path: `artifacts/skybao-film/review/targeted/frame-${String(frame).padStart(4, "0")}.png`,
       sha256: receipt.hashes[String(frame)],
     }]));
     const stagedReceiptPath = path.join(stage, "targeted-review-receipt.json");
    fs.mkdirSync(path.dirname(stagedReceiptPath), { recursive: true });
    fs.writeFileSync(stagedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    // Receipt is promoted atomically with the exact scene and PNG set.
    var targetedReceiptPromotion = { source: stagedReceiptPath, target: targetedReceiptPath };
  }
  const reviewTarget = path.join(artifactRoot, "review");
  const mergedReviewRoot = path.join(stage, "review-merged");
  if (exists(reviewTarget) && !canonicalTargeted)
    fs.cpSync(reviewTarget, mergedReviewRoot, { recursive: true });
  else fs.mkdirSync(mergedReviewRoot, { recursive: true });
  fs.cpSync(stagedReviewRoot, mergedReviewRoot, {
    recursive: true,
    force: true,
  });
  promoteWithRollback(
    [
      { source: stagedBlendPath, target: blendPath },
      { source: stagedManifestPath, target: buildManifestPath },
      { source: stagedAudioPath, target: audioPath },
      { source: mergedReviewRoot, target: reviewTarget },
       ...(canonicalTargeted ? [targetedReceiptPromotion,
         { source: stagedReviewBlendPath, target: reviewBlendPath },
         { source: stagedReviewManifestPath, target: reviewManifestPath },
         { source: stagedReviewAudioPath, target: reviewAudioPath },
         { source: stagedReviewRootDedicated, target: reviewRoot }] : []),
    ],
    stage
  );
  discardStage(stage);
  console.log(`\nReview frames ready: ${reviewTarget}`);
  console.log(`Editable project: ${blendPath}`);
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
const stagedOutputPath = path.join(stage, outputName);
const versionedManifestName = `build-manifest-${mode}.json`;
const versionedManifestPath = path.join(deliverableRoot, versionedManifestName);
const stagedVersionedManifestPath = path.join(stage, versionedManifestName);
const versionedBlendName = `skybao-film-${mode}.blend`;
const versionedBlendPath = path.join(artifactRoot, versionedBlendName);
const stagedVersionedBlendPath = path.join(stage, versionedBlendName);
const reportPath = path.join(deliverableRoot, `render-report-${mode}.json`);
const stagedReportPath = path.join(stage, path.basename(reportPath));
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
  stagedAudioPath,
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
  stagedOutputPath,
];
const encodeRun = run(ffmpeg, encodeArgs, `encode ${outputName}`);

const probe = run(
  ffprobe,
  [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,pix_fmt,color_space,color_transfer,color_primaries",
    "-of",
    "json",
    stagedOutputPath,
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

const blackDetect = run(
  ffmpeg,
  [
    "-hide_banner",
    "-i",
    stagedOutputPath,
    "-vf",
    "blackdetect=d=0.1:pix_th=0.01",
    "-an",
    "-f",
    "null",
    "-",
  ],
  "detect black frames",
  { capture: true }
);
if (/black_(?:start|end|duration):/.test(blackDetect.stderr || ""))
  throw new Error("encoded video contains a detected black segment");

const report = {
  schemaVersion: 2,
  inputFingerprint: boundManifest.inputFingerprint,
  title: "SkyBao · The Acme Workspace Flow",
  mode,
  durationSeconds: duration,
  frames: 1200,
  fps: 30,
  dimensions,
  validation: {
    contiguousFrames: true,
    blackSegments: 0,
    framesRetained: keepFrames,
  },
  render: {
    engine: buildManifest.engine,
    cycles: {
      requestedDevice: cyclesDevice,
      manifestRequestedDevice: buildManifest.deviceRequested,
      resolvedDevice: buildManifest.deviceResolved,
      fallback: buildManifest.deviceFallback,
      computeDeviceType: buildManifest.computeDeviceType,
      activeDeviceIds: buildManifest.activeDeviceIds,
      metalRT: buildManifest.metalRT,
      profile: buildManifest.profile || mode,
      samples: buildManifest.samples,
      adaptiveThreshold: buildManifest.adaptiveThreshold,
      resolutionPercentage: buildManifest.resolutionPercentage,
      seed: buildManifest.seed,
      animatedSeed: buildManifest.animatedSeed,
      persistentData: buildManifest.persistentData,
      denoise: buildManifest.denoise,
      bounces: buildManifest.bounces,
      devices: buildManifest.devices,
      elapsedRenderSeconds: buildManifest.elapsedRenderSeconds,
    },
    elapsed: {
      totalMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      blenderMs: blenderRun.elapsedMs,
      encodeMs: encodeRun.elapsedMs,
    },
  },
  video,
  audio,
  files: {
    video: path.relative(repo, outputPath),
    blend: path.relative(repo, versionedBlendPath),
    mix: path.relative(repo, audioPath),
    buildManifest: path.relative(repo, versionedManifestPath),
  },
  sha256: {
    video: sha256(stagedOutputPath),
    blend: sha256(stagedBlendPath),
    mix: sha256(stagedAudioPath),
    buildManifest: sha256(stagedManifestPath),
  },
  provenance: {
    inputFingerprint: boundManifest.inputFingerprint,
    buildManifest: {
      path: path.relative(repo, versionedManifestPath),
      schemaVersion: buildManifest.raw.schemaVersion ?? null,
      sha256: sha256(stagedManifestPath),
    },
  },
};
fs.copyFileSync(stagedBlendPath, stagedVersionedBlendPath);
const versionedManifest = JSON.parse(fs.readFileSync(stagedManifestPath, "utf8"));
versionedManifest.artifacts = {
  ...(versionedManifest.artifacts || {}),
  blend: { path: path.relative(repo, versionedBlendPath), sha256: sha256(stagedVersionedBlendPath) },
};
fs.writeFileSync(stagedVersionedManifestPath, `${JSON.stringify(versionedManifest, null, 2)}\n`);
// Reports bind to the immutable profile manifest (including its blend hash),
// not merely to the unversioned editable manifest.
report.provenance.buildManifest.sha256 = sha256(stagedVersionedManifestPath);
report.sha256.buildManifest = sha256(stagedVersionedManifestPath);
fs.writeFileSync(stagedReportPath, `${JSON.stringify(report, null, 2)}\n`);

const promotions = [
  { source: stagedBlendPath, target: blendPath },
  { source: stagedVersionedBlendPath, target: versionedBlendPath },
  { source: stagedManifestPath, target: buildManifestPath },
  { source: stagedVersionedManifestPath, target: versionedManifestPath },
  { source: stagedOutputPath, target: outputPath },
  { source: stagedReportPath, target: reportPath },
  { source: stagedAudioPath, target: audioPath },
];
if (keepFrames)
  promotions.push({
    source: framesDir,
    target: path.join(artifactRoot, "frames", mode),
  });
else
  promotions.push({
    remove: true,
    target: path.join(artifactRoot, "frames", mode),
  });
promoteWithRollback(promotions, stage);
discardStage(stage);

// Full handoff is deliberately explicit. Rendering must never report failure
// after promoting a valid render merely because optional review derivatives
// could not be generated; run `yarn video:film:handoff` as a separate atomic
// post-render transaction.

console.log(`\nSkyBao film ready`);
console.log(`  video:  ${outputPath}`);
console.log(`  blend:  ${blendPath}`);
console.log(`  locked: ${versionedBlendPath}`);
console.log(`  report: ${reportPath}`);
console.log(`  sha256: ${report.sha256.video}`);
console.log(
  `  frames: ${keepFrames ? path.join(artifactRoot, "frames", mode) : "removed after verified encode"}`
);
