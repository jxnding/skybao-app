#!/usr/bin/env node
// Validate the durable SkyBao film recipe and every captured source frame.
"use strict";

import fs from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { inputFingerprint, sha256 } from "./provenance.mjs";

const filmDir = path.dirname(fileURLToPath(import.meta.url));
const cliArgs = process.argv.slice(2);
let repoArgIndex = -1;
let manifestPathArg = null;
let audioPathArg = null;
let strictProvenance = false;
let targetedReview = false;
const valueOptions = new Set();
for (let index = 0; index < cliArgs.length; index += 1) {
   if (!["--repo", "--manifest", "--audio"].includes(cliArgs[index]) && !["--strict-provenance", "--targeted-review"].includes(cliArgs[index])) {
    console.error(`error: unknown option: ${cliArgs[index]}`);
    process.exit(2);
  }
   if (cliArgs[index] === "--strict-provenance") {
    strictProvenance = true;
    continue;
   }
   if (cliArgs[index] === "--targeted-review") { targetedReview = true; continue; }
  if (valueOptions.has(cliArgs[index]) || !cliArgs[index + 1] || cliArgs[index + 1].startsWith("-")) {
    console.error(`error: missing value for ${cliArgs[index]}`);
    process.exit(2);
  }
  valueOptions.add(cliArgs[index]);
  if (cliArgs[index] === "--repo") repoArgIndex = index;
  if (cliArgs[index] === "--manifest") manifestPathArg = cliArgs[index + 1];
  if (cliArgs[index] === "--audio") audioPathArg = cliArgs[index + 1];
  index += 1;
}
const repo = path.resolve(repoArgIndex >= 0 ? cliArgs[repoArgIndex + 1] : path.resolve(filmDir, "../../../.."));
const selectedFilmDir = repoArgIndex >= 0
  ? path.join(repo, "frontend", "scripts", "video", "film") : filmDir;
if (repoArgIndex >= 0 && (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory())) {
  console.error(`error: repository does not exist: ${repo}`);
  process.exit(2);
}
if (repoArgIndex >= 0 && !fs.existsSync(selectedFilmDir)) {
  console.error(`error: alternate repository has no frontend/scripts/video/film: ${repo}`);
  process.exit(2);
}
const timingPath = path.join(repo, "frontend", "src", "pages", "NativeArea", "captureNavigationTiming.js");
let CAPTURE_NAVIGATION_TIMING;
try {
  const timingModule = await import(pathToFileURL(timingPath).href);
  CAPTURE_NAVIGATION_TIMING = timingModule.CAPTURE_NAVIGATION_TIMING;
  if (!CAPTURE_NAVIGATION_TIMING || typeof CAPTURE_NAVIGATION_TIMING !== "object" ||
      ["clickFrame", "drawerCloseStartFrame", "flipStartFrame"].some((key) =>
        !Number.isInteger(CAPTURE_NAVIGATION_TIMING[key])))
    throw new Error("CAPTURE_NAVIGATION_TIMING is malformed");
} catch (error) {
  console.error(`error: missing or malformed capture navigation timing: ${timingPath} (${error.message})`);
  process.exit(2);
}
const shotlistPath = path.join(selectedFilmDir, "shotlist.json");
const environmentPath = path.join(selectedFilmDir, "environment.json");
const catalogFilePath = path.join(repo, "artifacts", "skybao-ui", "catalog.json");
const uiRoot = path.join(repo, "artifacts", "skybao-ui");
const filmRoot = path.join(repo, "artifacts", "skybao-film");
const canonicalAudioRelative = (targetedReview || manifestPathArg?.includes("targeted-review") || audioPathArg?.includes("targeted-review-mix"))
  ? "artifacts/skybao-film/audio/targeted-review-mix.wav"
  : "artifacts/skybao-film/audio/skybao-mix.wav";
const buildManifestPath = manifestPathArg
  ? path.resolve(manifestPathArg)
  : path.join(filmRoot, "build-manifest.json");

const errors = [];
const warnings = [];
const ok = (message) => console.log(`  ok    ${message}`);
const fail = (message) => errors.push(message);
const readJson = (file, label = file) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!object(parsed)) {
      fail(`${label} must contain a JSON object`);
      return {};
    }
    return parsed;
  } catch (error) {
    fail(`${label} must be valid JSON (${error.message})`);
    return {};
  }
};
const frameName = (frame) => `frame-${String(frame).padStart(6, "0")}.png`;
const isSha256 = (value) => /^[a-f0-9]{64}$/.test(value || "");
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const integer = (value) => Number.isInteger(value);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonemptyString = (value) => typeof value === "string" && value.trim().length > 0;
const stableJson = (value) => JSON.stringify(value, (_key, item) =>
  object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const finiteArray = (value, length = 3) => Array.isArray(value) && value.length >= length && value.slice(0, length).every(finite);
const colorValue = (value) => (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) || finiteArray(value, 3);
const MAX_FRAME = 100000;
const MAX_FRAME_RANGE = 10000;

// Catalog paths are data, not trusted filesystem paths. Keep this check in one
// place so every catalog consumer gets the same traversal and prefix rules.
function catalogPath(value, label) {
  check(nonemptyString(value), `${label} must be a nonempty relative path`);
  if (!nonemptyString(value)) return null;
  const candidate = value.trim();
  const urlLike = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate) || candidate.startsWith("//");
  const absolute = path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\");
  const parts = candidate.replaceAll("\\", "/").split("/");
  const escaped = parts.some((part) => part === "..");
  let resolved;
  try { resolved = fs.realpathSync(path.resolve(uiRoot, ...parts)); } catch { resolved = null; }
  const realRoot = fs.realpathSync.native ? fs.realpathSync.native(uiRoot) : path.resolve(uiRoot);
  const relative = resolved ? path.relative(realRoot, resolved) : "..";
  const contained = resolved && relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  check(!absolute && !escaped && !urlLike && contained,
    `${label} must stay under artifacts/skybao-ui`);
  return !absolute && !escaped && !urlLike && contained ? resolved : null;
}

function sourceFramePath(directory, frame, label) {
  const candidate = path.join(directory, frameName(frame));
  let resolved;
  try { resolved = fs.realpathSync(candidate); } catch { resolved = null; }
  const root = fs.realpathSync.native ? fs.realpathSync.native(directory) : path.resolve(directory);
  const relative = resolved ? path.relative(root, resolved) : "..";
  const contained = Boolean(resolved) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && relative !== "";
  check(contained, `${label} escapes its catalog clip directory`);
  return contained ? resolved : null;
}

function repoPath(value, label) {
  check(nonemptyString(value), `${label} must be a nonempty relative repository path`);
  if (!nonemptyString(value)) return null;
  const candidate = value.trim();
  const absolute = path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\");
  const urlLike = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate) || candidate.startsWith("//");
  let resolved;
  try { resolved = fs.realpathSync(path.resolve(repo, candidate)); } catch { resolved = null; }
  const root = fs.realpathSync.native ? fs.realpathSync.native(repo) : repo;
  const relative = resolved ? path.relative(root, resolved) : "..";
  const contained = resolved && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  check(!absolute && !urlLike && !candidate.replaceAll("\\", "/").split("/").includes("..") && contained,
    `${label} must stay under the repository root`);
  return !absolute && !urlLike && contained ? resolved : null;
}

function frameRange(start, end, label, maximum = MAX_FRAME) {
  const valid = integer(start) && integer(end) && start >= 1 && end >= start && end <= maximum && end - start + 1 <= MAX_FRAME_RANGE;
  check(valid, `${label} must be bounded integer frames (1..${maximum}, max ${MAX_FRAME_RANGE} frames)`);
  return valid;
}

function validateSfxCues(shot, index) {
  const cues = shot.sfxCues;
  if (!Array.isArray(cues)) { fail(`shot ${shot.number ?? index + 1}: sfxCues must be an array`); return; }
  cues.forEach((cue, cueIndex) => {
    const label = `shot ${shot.number ?? index + 1} sfxCues[${cueIndex}]`;
    check(object(cue), `${label} must be an object`);
    if (!object(cue)) return;
    check(["click", "whoosh", "chime"].includes(cue.type), `${label}.type is invalid`);
    check(integer(cue.frame) && cue.frame >= 1 && cue.frame <= (shot.frames?.count ?? 0), `${label}.frame must be an integer inside the shot`);
  });
}

function requireFile(file, label) {
  if (!fs.existsSync(file)) {
    fail(`missing ${label}: ${path.relative(repo, file)}`);
    return false;
  }
  return true;
}

function check(condition, message) {
  if (!condition) fail(message);
}

if (!requireFile(shotlistPath, "shotlist")) process.exit(1);
if (!requireFile(environmentPath, "environment recipe")) process.exit(1);
if (!requireFile(catalogFilePath, "UI catalog")) process.exit(1);

const shotlist = readJson(shotlistPath, "shotlist");
const environment = readJson(environmentPath, "environment recipe");
const catalog = readJson(catalogFilePath, "UI catalog");
const shotlistObject = object(shotlist);
const environmentObject = object(environment);
const catalogObject = object(catalog);
check(shotlistObject, "shotlist root must be a JSON object");
check(environmentObject, "environment recipe root must be a JSON object");
check(catalogObject, "UI catalog root must be a JSON object");
const shots = shotlistObject && Array.isArray(shotlist.shots) ? shotlist.shots : [];
if (shotlistObject && !Array.isArray(shotlist.shots)) fail("shotlist.shots must be an array");
const shotObjects = shots.filter(object);
shots.forEach((shot, index) => check(object(shot), `shot ${index + 1} must be an object`));
const direction = shotlistObject && object(shotlist.direction) ? shotlist.direction : {};
if (shotlistObject && !object(shotlist.direction)) fail("shotlist.direction must be an object");
const flips = Array.isArray(direction.flips) ? direction.flips : [];
if (!Array.isArray(direction.flips)) fail("shotlist.direction.flips must be an array");
const flipObjects = flips.filter(object);
const glassRoot = environmentObject && object(environment.glass) ? environment.glass : {};
const cameraRoot = environmentObject && object(environment.camera) ? environment.camera : {};
const editorialRoot = environmentObject && object(environment.editorial) ? environment.editorial : {};
const cloudCards = environmentObject && Array.isArray(environment.cloudCards) ? environment.cloudCards : [];
if (environmentObject && !object(environment.glass)) fail("environment.glass must be an object");
if (environmentObject && !object(environment.camera)) fail("environment.camera must be an object");
if (environmentObject && !object(environment.editorial)) fail("environment.editorial must be an object");
if (environmentObject && !Array.isArray(environment.cloudCards)) fail("environment.cloudCards must be an array");

console.log("SkyBao film · durable recipe validation");
console.log(`  shotlist: ${shotlistPath}`);

// --- immutable film shape ---
check(shotlist.schemaVersion === 2, "shotlist.schemaVersion must be 2");
check(
  shotlist.environment === "environment.json",
  "shotlist must reference environment.json"
);
check(shotlist.format?.fps === 30, "film must be 30fps");
check(
  shotlist.format?.frames === 1200,
  "film must contain exactly 1200 frames"
);
check(
  shotlist.format?.durationSeconds === 40,
  "film must be exactly 40 seconds"
);
check(
  shotlist.format?.width === 1920 && shotlist.format?.height === 1080,
  "film must be 1920x1080"
);
const targetedReviewFrames = shotlist.targetedReviewFrames;
check(Array.isArray(targetedReviewFrames) && targetedReviewFrames.length > 0,
  "shotlist.targetedReviewFrames must be a nonempty array");
if (Array.isArray(targetedReviewFrames)) {
  check(new Set(targetedReviewFrames).size === targetedReviewFrames.length,
    "shotlist.targetedReviewFrames must not contain duplicates");
  targetedReviewFrames.forEach((frame, index) => check(integer(frame) && frame >= 1 && frame <= 1200,
    `shotlist.targetedReviewFrames[${index}] must be within 1..1200`));
}
check(
  shotlist.shotCount === 19 && shots.length === 19,
  "recipe must contain exactly 19 shots"
);
check(catalog.schemaVersion === 2, "UI catalog schemaVersion must be 2");
check(
  catalog.recipeVersion === "skybao-capture-v4",
  "UI catalog recipeVersion must be skybao-capture-v4"
);

const navigationTiming = object(direction.navigationTiming) ? direction.navigationTiming : {};
if (!object(direction.navigationTiming)) fail("shotlist.direction.navigationTiming must be an object");
for (const key of ["clickFrame", "drawerCloseStartFrame", "flipStartFrame"])
  check(
    navigationTiming[key] === CAPTURE_NAVIGATION_TIMING[key],
    `shotlist navigation ${key} must match the shared capture timing`
  );
check(
  navigationTiming.clickFrame < navigationTiming.drawerCloseStartFrame &&
    navigationTiming.drawerCloseStartFrame < navigationTiming.flipStartFrame,
  "navigation timing must satisfy click < drawer close < flip start"
);

const groupOrder = [
  "assistant",
  "knowledge",
  "communications",
  "work",
  "admin",
];
const faces = {
  assistant: "front",
  knowledge: "back",
  communications: "front",
  work: "back",
  admin: "front",
};
check(
  JSON.stringify(shotlist.groupOrder) === JSON.stringify(groupOrder),
  "groupOrder must be Assistant, Knowledge, Communications, Work, Admin"
);

let expectedStart = 1;
let previousGroup = null;
const seenGroups = [];
for (const [index, shot] of shots.entries()) {
  if (!object(shot)) continue;
  const shotFrames = object(shot.frames) ? shot.frames : {};
  if (!object(shot.frames)) fail(`shot ${index + 1}: frames must be an object`);
  const validShotRange = frameRange(shotFrames.start, shotFrames.end, `shot ${index + 1} frame range`, 1200);
  const expectedNumber = index + 1;
  check(
    shot.number === expectedNumber,
    `shot ${expectedNumber}: number must be ${expectedNumber}`
  );
  check(
    groupOrder.includes(shot.group),
    `shot ${shot.number}: unknown group ${shot.group}`
  );
  check(
    shot.face === faces[shot.group],
    `shot ${shot.number}: ${shot.group} must use ${faces[shot.group]} face`
  );
  check(
    shotFrames.start === expectedStart,
    `shot ${shot.number}: starts ${shotFrames.start}, expected ${expectedStart}`
  );
  const count = validShotRange ? shotFrames.end - shotFrames.start + 1 : NaN;
  check(
    shotFrames.count === count,
    `shot ${shot.number}: frame count must equal inclusive range`
  );
  if (validShotRange) expectedStart = shotFrames.end + 1;

  if (shot.group !== previousGroup) {
    seenGroups.push(shot.group);
    previousGroup = shot.group;
  }
  const previous = shots[index - 1];
  if (object(previous) && previous.group === shot.group) {
    check(
      shot.transitionIn?.type === "same-face-dissolve",
      `shot ${shot.number}: same-group cut needs a same-face dissolve`
    );
    check(
      shot.transitionIn?.frames === 6,
      `shot ${shot.number}: same-face dissolve must be 6 frames`
    );
  } else if (object(previous)) {
    check(
      !shot.transitionIn,
      `shot ${shot.number}: area entry must be revealed by the preceding flip, not a dissolve`
    );
  }
  check(
    Array.isArray(shot.sfxCues),
    `shot ${shot.number}: sfxCues must be an array`
  );
  validateSfxCues(shot, index);
}
check(
  expectedStart === 1201,
  `shots must cover 1..1200, ended at ${expectedStart - 1}`
);
check(
  JSON.stringify(seenGroups) === JSON.stringify(groupOrder),
  "groups must be contiguous and appear in the five required areas"
);
ok("19 contiguous shots cover exactly 1..1200 at 30fps");

const actions = shotObjects.filter((shot) => shot.kind === "action");
const navigations = shotObjects.filter((shot) => shot.kind === "navigation");
const holds = shotObjects.filter((shot) => shot.kind === "final-hold");
check(actions.length === 14, "recipe must have 14 action shots");
check(navigations.length === 4, "recipe must have 4 navigation bridges");
check(
  holds.length === 1 && holds[0]?.id === "admin-models-final",
  "recipe must end with exactly one Admin final hold"
);

const navigationIds = [
  "area-nav-assistant-knowledge",
  "area-nav-knowledge-communications",
  "area-nav-communications-work",
  "area-nav-work-admin",
];
check(
  JSON.stringify(navigations.map((shot) => shot.id)) ===
    JSON.stringify(navigationIds),
  "navigation bridge IDs or order are incorrect"
);

const expectedFlips = [
  [231, 251, 241],
  [471, 491, 481],
  [711, 731, 721],
  [951, 971, 961],
];
check(
  shotlist.direction?.rotationDirection === "continuous clockwise",
  "area flips must be continuous clockwise"
);
check(
  shotlist.direction?.rotationFrames === 20,
  "area flips must be 20 frames"
);
check(
  shotlist.direction?.sameFaceDissolveFrames === 6,
  "same-face dissolves must be 6 frames"
);
check(
  shotlist.direction?.sameFaceDissolveWindow ===
    "incoming and outgoing opacity keys share S..S+5; complementary linear easing",
  "same-face dissolves must document a shared S..S+5 linear window"
);
check(
  flips.length === 4,
  "recipe must contain exactly 4 area flips"
);
flips.forEach((flip, index) => {
  if (!object(flip)) {
    fail(`flip ${index + 1} must be an object`);
    return;
  }
  const [start, end, edgeOn] = expectedFlips[index] || [];
  check(
    flip.start === start && flip.end === end && flip.edgeOn === edgeOn,
    `flip ${index + 1}: expected ${start}-${end}, edge-on ${edgeOn}`
  );
  check(
    flip.end - flip.start + 1 === 21,
    `flip ${index + 1}: inclusive 20-frame animation range must span 21 keyed frames`
  );
  check(
    flip.edgeOn === flip.start + 10,
    `flip ${index + 1}: edge-on must be centered on the beat`
  );
  check(
    flip.from === groupOrder[index] && flip.to === groupOrder[index + 1],
    `flip ${index + 1}: wrong group boundary`
  );
});
navigations.forEach((shot, index) => {
  const shotFrames = object(shot.frames) ? shot.frames : {};
  const flip = flips[index] || {};
  check(
    shot.transitionOut?.type === "area-flip",
    `shot ${shot.number}: navigation bridge must end in an area flip`
  );
  for (const key of ["start", "end", "edgeOn"])
    check(
      shot.transitionOut?.[key] === flip?.[key],
      `shot ${shot.number}: transitionOut.${key} must match flip ${index + 1}`
    );
  check(
    shot.transitionOut?.direction === "clockwise",
    `shot ${shot.number}: transitionOut must be clockwise`
  );
  check(
    shotFrames.start <= flip.start && shotFrames.end === flip.end,
    `shot ${shot.number}: bridge must carry its complete flip`
  );
});
ok(
  "five area groups, four clockwise flips, and six-frame same-face dissolves are valid"
);

// --- editorial graphics and camera focus choreography ---
// Positions are LEFT/CENTER anchors in panel screen space. Bounds below are a
// deliberately conservative approximation of Blender's portable Bfont glyph
// extents (advance .62em, tracking 1.05, 12% width and 35% height margin).
const callouts = shotlistObject && Array.isArray(shotlist.editorialCallouts) ? shotlist.editorialCallouts : [];
if (shotlistObject && !Array.isArray(shotlist.editorialCallouts)) fail("shotlist.editorialCallouts must be an array");
const expectedCalloutText = new Map([
  ["assistant", "Grounded Answers with Citations"],
  ["knowledge", "Unified Knowledge Search"],
  ["communications", "Connected Team Context"],
  ["work", "Automated Agent Workflows"],
  ["admin", "Enterprise Governance"],
]);
check(callouts.length === 5, "recipe must contain exactly five editorial callouts");
check(callouts.every(object), "editorial callouts must be objects");
const calloutIds = callouts.map((callout) => callout?.id);
check(calloutIds.every(nonemptyString) && new Set(calloutIds).size === callouts.length,
  "editorial callout IDs must be unique nonempty strings");
const glassForCallouts = glassRoot;
const safeInset = finite(glassForCallouts.uiInsetM) ? glassForCallouts.uiInsetM : 0.012;
const safePadding = 0.14;
const safeX = Math.max(0, (finite(glassForCallouts.widthM) ? glassForCallouts.widthM : 3.3) / 2 - safeInset - safePadding);
const safeZ = Math.max(0, (finite(glassForCallouts.heightM) ? glassForCallouts.heightM : 1.85625) / 2 - safeInset - safePadding);
for (const group of groupOrder) {
  const matches = callouts.filter((callout) => object(callout) && callout.group === group);
  check(matches.length === 1, `group ${group} must have exactly one editorial callout`);
  const callout = matches[0];
  if (!callout) continue;
  check(nonemptyString(callout.text) && callout.text === expectedCalloutText.get(group),
    `${group} callout copy is not the approved editorial title`);
  const words = nonemptyString(callout.text) ? callout.text.trim().split(/\s+/) : [];
  check(words.length >= 2 &&
    words.length <= 4,
    `${group} callout must be 2–4 words`);
  const shot = shots.find((item) => object(item) && item.id === callout.shotId);
  const calloutFrames = object(callout.frames) ? callout.frames : {};
  check(Boolean(shot), `${group} callout must reference an existing shot`);
  if (shot) {
    check(callout.face === shot.face, `${group} callout face must match its shot`);
    check(calloutFrames.start >= (object(shot.frames) ? shot.frames.start : NaN) && calloutFrames.end <= (object(shot.frames) ? shot.frames.end : NaN),
      `${group} callout must stay inside its opening shot`);
  }
  check(Array.isArray(callout.positionM) && callout.positionM.length === 2 &&
    callout.positionM.every(finite), `${group} callout position must be finite`);
  check(finite(callout.fontSizeM) && callout.fontSizeM >= 0.06 && callout.fontSizeM <= 0.18,
    `${group} callout font size must be 0.06–0.18m`);
  const estimatedWidth = nonemptyString(callout.text) && finite(callout.fontSizeM) ?
    callout.text.length * callout.fontSizeM * 0.62 * 1.05 * 1.12 : NaN;
  const estimatedHeight = finite(callout.fontSizeM) ? callout.fontSizeM * 1.35 : NaN;
  const calloutPosition = Array.isArray(callout.positionM) ? callout.positionM : [];
  const [x, z] = calloutPosition;
  check(finite(estimatedWidth) && finite(x) && finite(z) && x >= -safeX &&
    x + estimatedWidth <= safeX && z - estimatedHeight / 2 >= -safeZ &&
    z + estimatedHeight / 2 <= safeZ,
    `${group} callout text bounds exceed the panel safe area`);
  check(integer(calloutFrames.start) && integer(calloutFrames.end) &&
    calloutFrames.start <= calloutFrames.end && calloutFrames.start >= 1 &&
    calloutFrames.end <= 1200, `${group} callout frame window is invalid`);
  check(integer(callout.fadeFrames) && callout.fadeFrames >= 4 && callout.fadeFrames <= 12,
    `${group} callout fade must be 4–12 frames`);
  check(calloutFrames.start - callout.fadeFrames >= 1 &&
    calloutFrames.end + callout.fadeFrames <= 1200,
    `${group} callout fade exceeds film bounds`);
  check(!flipObjects.some((flip) =>
    calloutFrames.start - callout.fadeFrames <= flip.end &&
    calloutFrames.end + callout.fadeFrames >= flip.start),
    `${group} callout must not overlap a face flip`);
  const paddedCallout = [calloutFrames.start - callout.fadeFrames, calloutFrames.end + callout.fadeFrames];
  check(!shotObjects.some((item) => {
    const transition = item.transitionIn;
    if (!object(transition) || transition.type !== "same-face-dissolve") return false;
    const window = [item.frames?.start, item.frames?.start + transition.frames - 1];
    return paddedCallout[0] <= window[1] && paddedCallout[1] >= window[0];
  }), `${group} callout must not overlap a same-face dissolve`);
}
const cameraForFocus = cameraRoot;
const focusMoves = Array.isArray(cameraForFocus.focusMoves) ? cameraForFocus.focusMoves : [];
const focusMoveObjects = focusMoves.filter(object);
check(focusMoves.length >= 2, "camera must specify at least two focus moves");
check(focusMoves.every(object), "focus moves must be objects");
const focusIds = focusMoves.map((move) => move?.id);
check(focusIds.every(nonemptyString) && new Set(focusIds).size === focusMoves.length,
  "focus move IDs must be unique nonempty strings");
const baselineLens = finite(cameraForFocus.lensMM) ? cameraForFocus.lensMM : NaN;
const aspect = 16 / 9;
const panelWidth = finite(glassForCallouts.widthM) ? glassForCallouts.widthM : 3.3;
const panelHeight = finite(glassForCallouts.heightM) ? glassForCallouts.heightM : 1.85625;
const margin = 0.06;
const flipWindows = flips.filter(object).map((flip) => [flip.start, flip.end]);
const transitionWindows = shotObjects.flatMap((shot) => {
  const t = shot.transitionIn;
  if (!object(t) || t.type !== "same-face-dissolve") return [];
  return [[shot.frames?.start, shot.frames?.start + (t.frames || 0) - 1]];
});
const overlaps = (a, b) => a[0] <= b[1] && a[1] >= b[0];
for (const rawMove of focusMoves) {
  const move = object(rawMove) ? rawMove : {};
  const moveLabel = nonemptyString(move?.id) ? move.id : "<unnamed>";
  const shot = shotObjects.find((item) => item.id === move?.shotId);
  check(Boolean(shot), `focus move ${moveLabel} references an unknown shot`);
  if (shot) check(integer(move.start) && integer(move.end) && move.start >= (object(shot.frames) ? shot.frames.start : NaN) && move.end <= (object(shot.frames) ? shot.frames.end : NaN),
      `focus move ${moveLabel} must stay inside its shot`);
  check(Array.isArray(move.targetOffsetM) && move.targetOffsetM.length === 2 &&
    move.targetOffsetM.every(finite), `focus move ${moveLabel} target offset must be finite`);
  check(integer(move.start) && integer(move.end) && move.start >= 1 && move.end <= 1200 && move.end > move.start &&
    integer(move.easeFrames) && move.easeFrames >= 4 && move.easeFrames <= 12 &&
    move.easeFrames * 2 <= move.end - move.start,
    `focus move ${moveLabel} needs ordered integer frames and a 4–12 frame ease`);
  check(finite(move.lensStartMM) && finite(move.lensPeakMM) && finite(move.lensEndMM) &&
    move.lensStartMM >= 48 && move.lensStartMM <= 58 &&
    move.lensPeakMM >= 48 && move.lensPeakMM <= 58 &&
    move.lensEndMM >= 48 && move.lensEndMM <= 58 &&
    move.lensPeakMM >= Math.max(move.lensStartMM, move.lensEndMM) &&
    move.lensStartMM === baselineLens && move.lensEndMM === baselineLens &&
    Array.isArray(move.targetOffsetM) && move.targetOffsetM.length === 2,
    `focus move ${moveLabel} must return to the configured baseline lens`);
  const window = [move.start, move.end];
  check(!flipWindows.some((other) => overlaps(window, other)) &&
    !transitionWindows.some((other) => overlaps(window, other)) &&
    !focusMoveObjects.some((other) => other !== move && overlaps(window, [other.start, other.end])),
    `focus move ${moveLabel} overlaps a flip, transition, or another move`);
  const sensor = finite(cameraForFocus.sensorWidthMM) ? cameraForFocus.sensorWidthMM : 36;
  const distance = finite(cameraForFocus.distanceM) ? cameraForFocus.distanceM : NaN;
  const maxLens = Math.max(move.lensStartMM, move.lensPeakMM, move.lensEndMM);
  const viewW = distance * Math.tan(2 * Math.atan(sensor / (2 * maxLens)) / 2);
  const viewH = viewW / aspect;
  const offsetX = Math.abs(move.targetOffsetM?.[0] || 0);
  const offsetZ = Math.abs(move.targetOffsetM?.[1] || 0);
  check(finite(distance) && panelWidth / 2 + margin + offsetX <= viewW &&
    panelHeight / 2 + margin + offsetZ <= viewH,
    `focus move ${moveLabel} combined lens/offset leaves the panel frustum`);
}
ok("five safe lower-thirds and bounded eased focus moves are valid");

// --- environmental contract consumed by Blender ---
check(environment.schemaVersion === 1, "environment.schemaVersion must be 1");
check(finite(glassRoot.widthM) && finite(glassRoot.heightM) && finite(glassRoot.thicknessM) && integer(glassRoot.cornerSegments),
  "glass dimensions, thickness, and cornerSegments must be finite and shaped");
const uiWidth = finite(glassRoot.widthM) && finite(glassRoot.uiInsetM) ? glassRoot.widthM - 2 * glassRoot.uiInsetM : NaN;
const uiHeight = finite(uiWidth) ? uiWidth * 9 / 16 : NaN;
check(glassRoot.widthM > 0 && glassRoot.widthM <= 20 && glassRoot.heightM > 0 && glassRoot.heightM <= 20 && glassRoot.thicknessM > 0 && glassRoot.thicknessM <= 0.1,
  "glass width, height, and thickness must be positive and within sane bounds");
check(glassRoot.cornerSegments >= 3 && glassRoot.cornerSegments <= 64,
  "glass cornerSegments must be an integer from 3 to 64");
check(finite(glassRoot.uiInsetM) && glassRoot.uiInsetM >= 0 && glassRoot.uiInsetM < glassRoot.widthM / 2 && uiWidth > 0 && uiHeight > 0 && uiHeight <= glassRoot.heightM,
  "uiInsetM must be nonnegative and leave a valid aspect-preserving 16:9 UI rectangle");
check(finite(glassRoot.cornerRadiusM) && glassRoot.cornerRadiusM > 0 && glassRoot.cornerRadiusM <= Math.min(glassRoot.widthM, glassRoot.heightM) / 2 &&
  finite(glassRoot.uiMaskCornerRadiusM) && glassRoot.uiMaskCornerRadiusM > 0 && glassRoot.uiMaskCornerRadiusM <= Math.min(uiWidth, uiHeight) / 2,
  "glass and UI corner radii must be positive and fit their rectangles");
const editorialColorValid = typeof editorialRoot.textColor === "string"
  ? /^#[0-9a-f]{6}$/i.test(editorialRoot.textColor)
  : Array.isArray(editorialRoot.textColor) && editorialRoot.textColor.length === 3 &&
    editorialRoot.textColor.every((component) => finite(component) && component >= 0 && component <= 1);
check(editorialColorValid && finite(editorialRoot.emissionStrength) &&
  editorialRoot.emissionStrength >= 0 && editorialRoot.emissionStrength <= 100,
  "editorial.textColor must be #RRGGBB or 3 RGB values in 0..1 and emissionStrength must be 0..100");
check(Array.isArray(environment.edge?.palette) && environment.edge.palette.every(colorValue),
  "edge palette colors must be valid hex colors or finite RGB arrays");
check(cloudCards.every((card) =>
  object(card) && finite(card.opacity) && finite(card.emission) && colorValue(card.tint)),
  "cloud card opacity, emission, and tint must be finite");
check(
  environment.id === "skybao-glass-atmosphere",
  "environment id is incorrect"
);
check(
  Number.isInteger(environment.seed),
  "environment must have a deterministic integer seed"
);
check(
  environment.format?.fps === 30 &&
    environment.format?.width === 1920 &&
    environment.format?.height === 1080,
  "environment format must match the film"
);
check(glassRoot.thicknessM === 0.005, "glass must be 5mm thick");
check(
  glassRoot.cornerRadiusM > 0,
  "glass needs a rounded corner radius"
);
check(
  glassRoot.uiMaskCornerRadiusM > 0,
  "UI needs a matching rounded mask radius"
);
check(
  environment.glass?.layers?.backing?.roughness === 0.17 &&
    environment.glass?.layers?.backing?.transmission === 0.9 &&
    environment.glass?.layers?.backing?.ior === 1.45 &&
    environment.glass?.layers?.backing?.coatWeight === 0.18 &&
    environment.glass?.layers?.backing?.frostStrength === 0.06 &&
    environment.glass?.layers?.backing?.frostDistance === 0.012,
  "Cycles glass backing must match the approved frost/transmission profile"
);
check(
  environment.glass?.layers?.ui?.mode === "crisp-emissive",
  "UI layer must stay crisp and emissive"
);
check(
  environment.glass?.layers?.coverRim?.roughness === 0.025 &&
    environment.glass?.layers?.coverRim?.transmission === 1 &&
    environment.glass?.layers?.coverRim?.ior === 1.45 &&
    environment.glass?.layers?.coverRim?.coatWeight === 0.3 &&
    environment.glass?.layers?.coverRim?.opacity === 0.06,
  "Cycles glass cover must match the approved clear-rim profile"
);
check(
  Array.isArray(environment.edge?.palette) &&
    environment.edge.palette.length >= 2,
  "edge requires a cyan/blue palette"
);
check(
  environment.edge?.highlightPath === "rounded-perimeter",
  "edge highlight must travel a rounded perimeter"
);
check(
  environment.edge?.highlightCircuitSeconds >= 10 &&
    environment.edge?.highlightCircuitSeconds <= 15,
  "edge highlight circuit must be restrained (10–15 seconds)"
);
check(
  cloudCards.length === 3,
  "environment must use exactly three cloud cards"
);
const cloudDepths = cloudCards.map((card) => card?.depthM);
check(
  cloudDepths.every(
    (depth, index) => index === 0 || depth > cloudDepths[index - 1]
  ),
  "cloud cards must have ordered depths for parallax"
);
const camera = cameraRoot;
check(object(camera) && finite(camera.distanceM) && finite(camera.baselineDistanceM) &&
  finite(camera.lensMM) && finite(camera.sensorWidthMM) && finite(camera.maxBreathM) &&
  typeof camera.rackFocusAtAreaFlips === "boolean",
  "camera geometry, breathing, and rack-focus config must be shaped and finite");
const horizontalFov = finite(camera.sensorWidthMM) && finite(camera.lensMM) && camera.lensMM > 0 ?
  2 * Math.atan(camera.sensorWidthMM / (2 * camera.lensMM)) : NaN;
const projectedWidth = (distance) =>
  glassRoot.widthM / (2 * distance * Math.tan(horizontalFov / 2));
const currentCoverage = projectedWidth(camera.distanceM);
const baselineCoverage = projectedWidth(camera.baselineDistanceM);
const coverageIncrease = currentCoverage / baselineCoverage - 1;
check(
  currentCoverage >= 0.75 && currentCoverage <= 0.82,
  "glass should cover about 75–82 percent of frame width"
);
check(
  coverageIncrease >= 0.1 && coverageIncrease <= 0.15,
  "projected UI width must be 10–15 percent larger than the recorded baseline"
);
check(
  camera.maxBreathM <= 0.02,
  "camera breathing must remain subtle"
);
const render = environment.render || {};
check(render.engine === "CYCLES", "environment render engine must be CYCLES");
check(render.device?.default === "auto", "Cycles device default must be auto");
check(
  Array.isArray(render.device?.supported) &&
    ["auto", "metal", "cpu"].every((device) =>
      render.device.supported.includes(device)
    ),
  "Cycles device support must include auto, metal, and cpu"
);
check(render.device?.metalRT === "AUTO", "Cycles Metal RT mode must be AUTO");
for (const [profile, expected] of Object.entries({
  preview: {
    samples: 32,
    adaptiveThreshold: 0.03,
    resolutionPercentage: 50,
  },
  final: {
    samples: 128,
    adaptiveThreshold: 0.01,
    resolutionPercentage: 100,
  },
})) {
  const settings = render[profile] || {};
  check(
    settings.samples === expected.samples,
    `Cycles ${profile} samples must be ${expected.samples}`
  );
  check(
    settings.resolutionPercentage === expected.resolutionPercentage,
    `Cycles ${profile} resolution percentage must be ${expected.resolutionPercentage}`
  );
  check(
    settings.adaptiveThreshold === expected.adaptiveThreshold,
    `Cycles ${profile} adaptive threshold must be ${expected.adaptiveThreshold}`
  );
}
check(
  render.denoise?.type === "OIDN" && render.denoise?.useGpu === true,
  "Cycles must use GPU OIDN denoising"
);
check(
  render.denoise?.inputPasses === "RGB_ALBEDO_NORMAL" &&
    render.denoise?.prefilter === "ACCURATE" &&
    render.denoise?.quality === "HIGH",
  "Cycles OIDN must use RGB/albedo/normal, accurate prefilter, and high quality"
);
check(
  render.bounces?.max === 8 &&
    render.bounces?.transmission === 8 &&
    render.bounces?.transparent === 8 &&
    render.bounces?.glossy === 4 &&
    render.bounces?.diffuse === 2,
  "Cycles bounce budget must match the glass profile"
);
check(
  render.bounces?.caustics === false && render.bounces?.indirectClamp === 10,
  "Cycles caustics must be disabled with indirect clamp 10"
);
check(
  Number.isInteger(render.seed?.value) &&
    render.seed?.persistent === true &&
    render.seed?.animated === false,
  "Cycles render seed must be fixed, persistent, and non-animated"
);
const toolInputs = object(environment.toolInputs) ? environment.toolInputs : {};
for (const [name, input] of Object.entries(toolInputs)) {
  check(
    typeof input === "string" && input.length > 0,
    `environment tool input ${name} must be a path`
  );
  if (typeof input === "string") repoPath(input, `environment tool input ${name}`);
}
for (const [index, card] of cloudCards.entries()) {
  if (object(card) && "source" in card) repoPath(card.source, `environment cloudCards[${index}].source`);
}
const environmentText = JSON.stringify(environment).toLowerCase();
check(
  !/(magenta|\bred\b|\bgreen\b)/.test(environmentText),
  "environment must not contain magenta, red, or green accents"
);
ok(
  "rounded 5mm layered glass, cyan/blue edge, cloud cards, Cycles/OIDN, and stable enlarged camera are specified"
);

// A build manifest is generated by Blender, so it is optional before the
// first build. The render runner strictly checks the freshly written manifest;
// this source-only validator merely flags a stale previous artifact so a
// normal build can replace it instead of being blocked in a circular preflight.
if (fs.existsSync(buildManifestPath)) {
  const buildManifest = readJson(buildManifestPath);
  const builtRender = buildManifest.render || buildManifest.cycles || {};
  const valid =
    (builtRender.engine || buildManifest.blender?.engine) === "CYCLES" &&
    ["auto", "metal", "cpu"].includes(
      builtRender.deviceRequested || builtRender.requestedDevice
    ) &&
    ["metal", "cpu"].includes(
      builtRender.deviceResolved || builtRender.resolvedDevice
    ) &&
    ["preview", "final", "sample", "build"].includes(
      builtRender.profile || builtRender.quality
    ) &&
    Number.isInteger(builtRender.samples) &&
    builtRender.samples > 0 &&
    ["OIDN", "OPENIMAGEDENOISE"].includes(builtRender.denoise?.type) &&
    builtRender.denoise?.useGpu === true &&
    Boolean(builtRender.bounces) &&
    typeof builtRender.seed === "number" &&
    builtRender.persistentData === true &&
    (builtRender.deviceResolved !== "metal" ||
      (builtRender.computeDeviceType === "METAL" &&
        builtRender.activeDeviceIds?.length > 0));
  if (valid) {
    const portable =
      buildManifest.scene?.portable_dependencies?.missing === 0 &&
      buildManifest.scene?.portable_dependencies?.images > 0 &&
      buildManifest.scene?.portable_dependencies?.sounds === 1;
    ok(
      portable
        ? "existing build manifest records a portable resolved Cycles profile"
        : "historical render manifest records a resolved Cycles profile"
    );
  } else
    warnings.push(
      "existing build manifest predates the Cycles contract; the next build will replace it"
    );
} else {
  warnings.push(
    "no Blender build manifest yet; it will be produced by --build-only or a render"
  );
}

// Compare the manifest's declared build inputs with the selected repository,
// rather than treating the previous generated manifest as a precondition for
// a new build.  A normal validation reports drift; strict validation turns the
// same concise diagnostics into failures.  The optional audio override is
// used by render.mjs while its newly generated WAV is still in staging.
function validateManifestProvenance() {
  if (!fs.existsSync(buildManifestPath)) return;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(buildManifestPath, "utf8")); }
  catch { return; }
  if (!object(manifest)) return;
  const declared = new Map();
  const issue = (message) => strictProvenance ? fail(message) : warnings.push(message);
  if (manifest.inputFingerprint && manifest.inputFingerprint !== inputFingerprint(manifest))
    issue("manifest input fingerprint does not match its current inputs");
  const add = (label, entry, override = null) => {
    if (!object(entry) || !isSha256(entry.sha256) || !nonemptyString(entry.path)) {
      const message = `${label} has incomplete provenance`;
      issue(message);
      return;
    }
    const file = override || repoPath(entry.path, `${label}.path`);
    if (!file || !fs.existsSync(file)) {
      const message = `${label} is missing: ${entry.path}`;
      issue(message);
      return;
    }
    declared.set(label, { file, expected: entry.sha256 });
  };
  add("shotlist", manifest.shotlist);
  add("environment", manifest.environment);
  add("catalog", manifest.uiCatalog);
  const configured = new Map(Object.entries(environment.toolInputs || {}));
  for (const card of environment.cloudCards || [])
    if (object(card) && nonemptyString(card.source)) configured.set(`cloudCard-${card.id}`, card.source);
  configured.set("builder", "frontend/scripts/video/film/build-blender.py");
  configured.set("sceneContract", "frontend/scripts/video/film/scene-contract.py");
  const inputAssets = object(manifest.inputAssets) ? manifest.inputAssets : {};
  if (strictProvenance && Object.keys(inputAssets).sort().join("\0") !== [...configured.keys()].sort().join("\0"))
    fail("inputAssets must exactly match configured tool/cloud/builder/scene-contract inputs");
  for (const [name, relative] of configured) {
    add(`input ${name}`, inputAssets[name]);
    if (strictProvenance && inputAssets[name]?.path !== relative) fail(`input ${name} path is not recipe-derived`);
  }
  for (const name of Object.keys(inputAssets)) if (!configured.has(name)) issue(`input ${name} is not recipe-configured`);
  const audioFile = audioPathArg ? path.resolve(audioPathArg) : path.join(filmRoot, "audio", "skybao-mix.wav");
  if (strictProvenance && (!manifest.audio || !isSha256(manifest.audio.sha256))) fail("audio provenance is required");
  if (strictProvenance && manifest.audio?.path !== canonicalAudioRelative)
    fail(`audio provenance path must be exactly ${canonicalAudioRelative}`);
  if (manifest.audio) add("audio", manifest.audio, audioFile);
  if (strictProvenance && (!fs.existsSync(audioFile) || fs.statSync(audioFile).size === 0)) fail("audio is missing or empty");
  for (const [label, input] of declared) {
    let actual;
    try { actual = sha256(input.file); } catch { actual = null; }
    if (actual !== input.expected) {
      const message = `${label} is stale (manifest ${input.expected.slice(0, 12)}, current ${actual ? actual.slice(0, 12) : "missing"})`;
      issue(message);
    }
  }
  if (declared.size && ![...declared.values()].some(({ expected }) => expected)) {
    const message = "build manifest contains no declared input hashes";
    issue(message);
  }
  if (strictProvenance) {
    for (const [label, entry] of [["shotlist", manifest.shotlist], ["environment", manifest.environment], ["catalog", manifest.uiCatalog]])
      if (entry?.path !== { shotlist: "frontend/scripts/video/film/shotlist.json", environment: "frontend/scripts/video/film/environment.json", catalog: "artifacts/skybao-ui/catalog.json" }[label])
        fail(`${label} provenance path is not the selected recipe`);
    const expected = new Map();
    const assets = Array.isArray(catalog.assets) ? catalog.assets : [];
    for (const shot of shots) {
      const source = shot.source || {};
      const key = `${source.type}:${source.id}:${source.framing}`;
      let item = expected.get(key);
      if (!item) {
        const entry = assets.find((candidate) => candidate.type === source.type && candidate.id === source.id && candidate.framing === source.framing);
        if (!entry) continue;
        item = { type: source.type, id: source.id, framing: source.framing, ownerId: entry.ownerId,
          recipeVersion: entry.recipeVersion, recipeSha256: entry.recipeSha256, contentSha256: entry.contentSha256, trimRanges: [] };
        if (source.type === "clip") {
          item.timeline = entry.timeline;
          item.timelineSha256 = sha256(catalogPath(entry.timeline, `used asset ${key} timeline`));
        }
        expected.set(key, item);
      }
      if (source.type === "clip") item.trimRanges.push([source.startFrame, source.endFrame]);
    }
    const actual = Array.isArray(manifest.usedUiAssets) ? manifest.usedUiAssets : [];
    if (actual.length !== expected.size || new Set(actual.map((x) => `${x.type}:${x.id}:${x.framing}`)).size !== actual.length)
      fail("usedUiAssets must be the complete unique selected catalog set");
    for (const [key, value] of expected) {
      const found = actual.find((x) => `${x.type}:${x.id}:${x.framing}` === key);
      if (!found || stableJson(found) !== stableJson(value)) fail(`usedUiAssets mismatch for ${key}`);
    }
  }
}

validateManifestProvenance();

// --- catalog, timeline, and every PNG input ---
const catalogEntries = new Map();
const catalogAssets = catalogObject && Array.isArray(catalog.assets) ? catalog.assets : [];
if (catalogObject && !Array.isArray(catalog.assets)) fail("UI catalog assets must be an array");
for (const [assetIndex, rawEntry] of catalogAssets.entries()) {
  if (!object(rawEntry)) {
    fail(`UI catalog assets[${assetIndex}] must be an object`);
    continue;
  }
  const entry = rawEntry;
  for (const key of ["file", "directory", "timeline"]) {
    if (key in entry) catalogPath(entry[key], `UI catalog assets[${assetIndex}].${key}`);
  }
  if (entry.type === "clip") {
    check(integer(entry.frameCount) && entry.frameCount >= 1 && entry.frameCount <= MAX_FRAME,
      `UI catalog assets[${assetIndex}].frameCount must be a bounded positive integer`);
    check(catalogPath(entry.directory, `UI catalog assets[${assetIndex}].directory`),
      `UI catalog assets[${assetIndex}] clip directory is invalid`);
    check(catalogPath(entry.timeline, `UI catalog assets[${assetIndex}].timeline`),
      `UI catalog assets[${assetIndex}] clip timeline is invalid`);
  } else if (entry.type === "still") {
    check(catalogPath(entry.file, `UI catalog assets[${assetIndex}].file`),
      `UI catalog assets[${assetIndex}] still file is invalid`);
  }
  catalogEntries.set(`${entry.type}:${entry.id}:${entry.framing}`, entry);
}

// Validate all timeline records, not just those currently selected by the
// recipe. This prevents an unused malformed nested event from reaching a
// later builder/audio consumer.
for (const [assetIndex, entry] of catalogAssets.entries()) {
  if (!object(entry) || entry.type !== "clip") continue;
  const timelinePath = catalogPath(entry.timeline, `UI catalog assets[${assetIndex}].timeline`);
  if (!timelinePath || !requireFile(timelinePath, `UI catalog assets[${assetIndex}] timeline`)) continue;
  const timeline = readJson(timelinePath, `UI catalog assets[${assetIndex}] timeline`);
  const cursor = Array.isArray(timeline.cursor) ? timeline.cursor : [];
  check(Array.isArray(timeline.cursor), `UI catalog assets[${assetIndex}] timeline.cursor must be an array`);
  check(integer(timeline.frameCount) && timeline.frameCount >= 1 && timeline.frameCount <= MAX_FRAME && timeline.frameCount === entry.frameCount,
    `UI catalog assets[${assetIndex}] timeline.frameCount must be bounded`);
  for (const [eventIndex, event] of cursor.entries()) {
    const label = `UI catalog assets[${assetIndex}] cursor[${eventIndex}]`;
    check(object(event), `${label} must be an object`);
    if (!object(event)) continue;
    check(integer(event.frame) && event.frame >= 0 && event.frame < timeline.frameCount, `${label}.frame is invalid`);
    check(finite(event.nx) && event.nx >= 0 && event.nx <= 1, `${label}.nx is invalid`);
    check(finite(event.ny) && event.ny >= 0 && event.ny <= 1, `${label}.ny is invalid`);
    check(["move", "down", "up", "click"].includes(event.event), `${label}.event is invalid`);
  }
}

const sourceErrorsBefore = errors.length;
for (const shot of shotObjects) {
  if (!object(shot.source)) {
    fail(`shot ${shot.number}: source must be an object`);
    continue;
  }
  const source = shot.source;
  const validSourceRange = source.type === "clip" && frameRange(
    source.startFrame, source.endFrame, `shot ${shot.number}: source frame range`,
    MAX_FRAME
  );
  check(
    source.framing === "workspace",
    `shot ${shot.number}: ${shot.kind} source must be workspace-framed`
  );
  const entry = catalogEntries.get(
    `${source.type}:${source.id}:${source.framing}`
  );
  if (!entry) {
    fail(
      `shot ${shot.number}: missing catalog asset ${source.type}:${source.id}:${source.framing}`
    );
    continue;
  }
  check(
    entry.ownerId === source.id,
    `shot ${shot.number}: ${source.id} must identify its capture owner`
  );
  check(
    entry.recipeVersion === "skybao-capture-v4" && isSha256(entry.recipeSha256),
    `shot ${shot.number}: ${source.id} has a legacy or invalid recipe digest`
  );
  check(
    isSha256(entry.contentSha256),
    `shot ${shot.number}: ${source.id} has no valid content digest`
  );
  if (source.type === "still") {
    check(
      nonemptyString(entry.file),
      `shot ${shot.number}: ${source.id} catalog entry must have a file path`
    );
    const stillPath = catalogPath(entry.file, `shot ${shot.number} catalog file`);
    if (!stillPath) continue;
    requireFile(stillPath, `shot ${shot.number} still`);
    continue;
  }
  if (source.type !== "clip") {
    fail(`shot ${shot.number}: unsupported source type ${source.type}`);
    continue;
  }
  if (!validSourceRange) continue;
  const trimLength = source.endFrame - source.startFrame + 1;
  check(
    trimLength === (object(shot.frames) ? shot.frames.count : NaN),
    `shot ${shot.number}: clip trim length ${trimLength} != shot duration ${object(shot.frames) ? shot.frames.count : NaN}`
  );
  check(
    integer(entry.frameCount) && source.endFrame <= entry.frameCount,
    `shot ${shot.number}: trim outside ${source.id} frame range`
  );
  check(
    nonemptyString(entry.directory),
    `shot ${shot.number}: ${source.id} catalog entry must have a directory path`
  );
  check(
    nonemptyString(entry.timeline),
    `shot ${shot.number}: ${source.id} catalog entry must have a timeline path`
  );
  const sourceDir = catalogPath(entry.directory, `shot ${shot.number} catalog directory`);
  const timelinePath = catalogPath(entry.timeline, `shot ${shot.number} catalog timeline`);
  if (!sourceDir || !timelinePath) continue;
  if (!requireFile(timelinePath, `shot ${shot.number} cursor timeline`))
    continue;
  const timeline = readJson(timelinePath);
  const cursor = Array.isArray(timeline.cursor) ? timeline.cursor : [];
  check(
    Array.isArray(timeline.cursor),
    `shot ${shot.number}: cursor timeline needs a cursor array`
  );
  check(
    integer(timeline.frameCount) && timeline.frameCount >= 1 && timeline.frameCount <= MAX_FRAME && timeline.frameCount === entry.frameCount && timeline.frameCount >= source.endFrame,
    `shot ${shot.number}: timeline is shorter than source trim`
  );
  for (const [eventIndex, event] of cursor.entries()) {
    const label = `shot ${shot.number} cursor[${eventIndex}]`;
    check(object(event), `${label} must be an object`);
    if (!object(event)) continue;
    check(integer(event.frame) && event.frame >= 0 && event.frame < timeline.frameCount,
      `${label}.frame must be a bounded timeline frame`);
    check(finite(event.nx) && event.nx >= 0 && event.nx <= 1,
      `${label}.nx must be finite and within 0..1`);
    check(finite(event.ny) && event.ny >= 0 && event.ny <= 1,
      `${label}.ny must be finite and within 0..1`);
    check(["move", "down", "up", "click"].includes(event.event),
      `${label}.event must be move, down, up, or click`);
  }
  if (shot.kind === "navigation") {
    const clickFrames =
      cursor
        .filter((event) => object(event) && event.event === "click")
        .map((event) => event.frame) || [];
    check(
      clickFrames.includes(navigationTiming.clickFrame),
      `shot ${shot.number}: navigation timeline must record the area click`
    );
    const flipStartFrame = shot.transitionOut?.start - (object(shot.frames) ? shot.frames.start : NaN);
    check(
      flipStartFrame === navigationTiming.flipStartFrame,
      `shot ${shot.number}: flip must start at shared navigation frame ${navigationTiming.flipStartFrame}`
    );
    check(
      navigationTiming.clickFrame < navigationTiming.drawerCloseStartFrame &&
        navigationTiming.drawerCloseStartFrame < flipStartFrame,
      `shot ${shot.number}: expected click < drawer close < flip start`
    );
  }
  let missingFrames = 0;
  for (let frame = source.startFrame; frame <= source.endFrame; frame += 1) {
    if (!sourceFramePath(sourceDir, frame, `shot ${shot.number} source PNG ${frame}`))
      missingFrames += 1;
  }
  check(
    missingFrames === 0,
    `shot ${shot.number}: ${missingFrames} referenced source PNG frame(s) missing from ${entry.directory}`
  );
}
if (errors.length === sourceErrorsBefore)
  ok("every referenced still, clip timeline, and source PNG frame was checked");

// --- optional generated score ---
const wavPath = path.join(filmRoot, "audio", "skybao-mix.wav");
if (!fs.existsSync(wavPath))
  warnings.push(`no generated WAV yet at ${wavPath}`);

console.log("");
if (errors.length) {
  console.error(`FAILED with ${errors.length} error(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
for (const warning of warnings) console.warn(`  warn ${warning}`);
console.log("validate: PASS");
