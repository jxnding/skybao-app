#!/usr/bin/env node
// Validate the durable SkyBao film recipe and every captured source frame.
"use strict";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CAPTURE_NAVIGATION_TIMING } from "../../../src/pages/NativeArea/captureNavigationTiming.js";

const filmDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(filmDir, "../../../..");
const shotlistPath = path.join(filmDir, "shotlist.json");
const environmentPath = path.join(filmDir, "environment.json");
const catalogPath = path.join(repo, "artifacts", "skybao-ui", "catalog.json");
const uiRoot = path.join(repo, "artifacts", "skybao-ui");
const filmRoot = path.join(repo, "artifacts", "skybao-film");

const errors = [];
const warnings = [];
const ok = (message) => console.log(`  ok    ${message}`);
const fail = (message) => errors.push(message);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const frameName = (frame) => `frame-${String(frame).padStart(6, "0")}.png`;
const isSha256 = (value) => /^[a-f0-9]{64}$/.test(value || "");

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
if (!requireFile(catalogPath, "UI catalog")) process.exit(1);

const shotlist = readJson(shotlistPath);
const environment = readJson(environmentPath);
const catalog = readJson(catalogPath);
const shots = shotlist.shots || [];

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
check(
  shotlist.shotCount === 19 && shots.length === 19,
  "recipe must contain exactly 19 shots"
);
check(catalog.schemaVersion === 2, "UI catalog schemaVersion must be 2");

const navigationTiming = shotlist.direction?.navigationTiming || {};
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
    shot.frames?.start === expectedStart,
    `shot ${shot.number}: starts ${shot.frames?.start}, expected ${expectedStart}`
  );
  const count = shot.frames?.end - shot.frames?.start + 1;
  check(
    shot.frames?.count === count,
    `shot ${shot.number}: frame count must equal inclusive range`
  );
  check(
    shot.frames?.start >= 1 && shot.frames?.end <= 1200,
    `shot ${shot.number}: frame range outside 1..1200`
  );
  expectedStart = (shot.frames?.end || 0) + 1;

  if (shot.group !== previousGroup) {
    seenGroups.push(shot.group);
    previousGroup = shot.group;
  }
  const previous = shots[index - 1];
  if (previous && previous.group === shot.group) {
    check(
      shot.transitionIn?.type === "same-face-dissolve",
      `shot ${shot.number}: same-group cut needs a same-face dissolve`
    );
    check(
      shot.transitionIn?.frames === 6,
      `shot ${shot.number}: same-face dissolve must be 6 frames`
    );
  } else if (previous) {
    check(
      !shot.transitionIn,
      `shot ${shot.number}: area entry must be revealed by the preceding flip, not a dissolve`
    );
  }
  check(
    Array.isArray(shot.sfxCues),
    `shot ${shot.number}: sfxCues must be an array`
  );
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

const actions = shots.filter((shot) => shot.kind === "action");
const navigations = shots.filter((shot) => shot.kind === "navigation");
const holds = shots.filter((shot) => shot.kind === "final-hold");
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
  shotlist.direction?.flips?.length === 4,
  "recipe must contain exactly 4 area flips"
);
(shotlist.direction?.flips || []).forEach((flip, index) => {
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
  const flip = shotlist.direction.flips[index];
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
    shot.frames.start <= flip.start && shot.frames.end === flip.end,
    `shot ${shot.number}: bridge must carry its complete flip`
  );
});
ok(
  "five area groups, four clockwise flips, and six-frame same-face dissolves are valid"
);

// --- environmental contract consumed by Blender ---
check(environment.schemaVersion === 1, "environment.schemaVersion must be 1");
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
check(environment.glass?.thicknessM === 0.005, "glass must be 5mm thick");
check(
  environment.glass?.cornerRadiusM > 0,
  "glass needs a rounded corner radius"
);
check(
  environment.glass?.uiMaskCornerRadiusM > 0,
  "UI needs a matching rounded mask radius"
);
check(
  environment.glass?.layers?.backing?.roughness > 0,
  "glass backing must be frosted"
);
check(
  environment.glass?.layers?.ui?.mode === "crisp-emissive",
  "UI layer must stay crisp and emissive"
);
check(
  environment.glass?.layers?.coverRim?.transmission > 0,
  "glass requires a clear front rim layer"
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
  Array.isArray(environment.cloudCards) && environment.cloudCards.length === 3,
  "environment must use exactly three cloud cards"
);
const cloudDepths = environment.cloudCards?.map((card) => card.depthM) || [];
check(
  cloudDepths.every(
    (depth, index) => index === 0 || depth > cloudDepths[index - 1]
  ),
  "cloud cards must have ordered depths for parallax"
);
const camera = environment.camera || {};
const horizontalFov =
  2 * Math.atan((camera.sensorWidthMM || 36) / (2 * camera.lensMM));
const projectedWidth = (distance) =>
  environment.glass.widthM / (2 * distance * Math.tan(horizontalFov / 2));
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
  environment.camera?.lockXY === true,
  "camera must remain spatially stable"
);
check(
  environment.camera?.maxBreathM <= 0.02,
  "camera breathing must remain subtle"
);
for (const [name, input] of Object.entries(environment.toolInputs || {})) {
  check(
    typeof input === "string" && input.length > 0,
    `environment tool input ${name} must be a path`
  );
  if (typeof input === "string")
    check(
      fs.existsSync(path.join(repo, input)),
      `environment tool input ${name} does not exist: ${input}`
    );
}
const environmentText = JSON.stringify(environment).toLowerCase();
check(
  !/(magenta|\bred\b|\bgreen\b)/.test(environmentText),
  "environment must not contain magenta, red, or green accents"
);
ok(
  "rounded 5mm layered glass, cyan/blue edge, cloud cards, and stable enlarged camera are specified"
);

// --- catalog, timeline, and every PNG input ---
const catalogEntries = new Map();
for (const entry of catalog.assets || [])
  catalogEntries.set(`${entry.type}:${entry.id}:${entry.framing}`, entry);

const sourceErrorsBefore = errors.length;
for (const shot of shots) {
  const source = shot.source || {};
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
    entry.recipeVersion === "skybao-capture-v2" && isSha256(entry.recipeSha256),
    `shot ${shot.number}: ${source.id} has a legacy or invalid recipe digest`
  );
  check(
    isSha256(entry.contentSha256),
    `shot ${shot.number}: ${source.id} has no valid content digest`
  );
  if (source.type === "still") {
    requireFile(path.join(uiRoot, entry.file), `shot ${shot.number} still`);
    continue;
  }
  if (source.type !== "clip") {
    fail(`shot ${shot.number}: unsupported source type ${source.type}`);
    continue;
  }
  const trimLength = source.endFrame - source.startFrame + 1;
  check(
    trimLength === shot.frames.count,
    `shot ${shot.number}: clip trim length ${trimLength} != shot duration ${shot.frames.count}`
  );
  check(
    source.startFrame >= 1 && source.endFrame <= entry.frameCount,
    `shot ${shot.number}: trim outside ${source.id} frame range`
  );
  const sourceDir = path.join(uiRoot, entry.directory);
  const timelinePath = path.join(uiRoot, entry.timeline || "");
  if (!requireFile(timelinePath, `shot ${shot.number} cursor timeline`))
    continue;
  const timeline = readJson(timelinePath);
  check(
    Array.isArray(timeline.cursor),
    `shot ${shot.number}: cursor timeline needs a cursor array`
  );
  check(
    timeline.frameCount >= source.endFrame,
    `shot ${shot.number}: timeline is shorter than source trim`
  );
  if (shot.kind === "navigation") {
    const clickFrames =
      timeline.cursor
        ?.filter((event) => event.event === "click")
        .map((event) => event.frame) || [];
    check(
      clickFrames.includes(navigationTiming.clickFrame),
      `shot ${shot.number}: navigation timeline must record the area click`
    );
    const flipStartFrame = shot.transitionOut?.start - shot.frames.start;
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
    if (!fs.existsSync(path.join(sourceDir, frameName(frame))))
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
