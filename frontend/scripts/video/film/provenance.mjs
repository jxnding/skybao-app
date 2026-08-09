import crypto from "crypto";
import fs from "fs";
import path from "path";

export function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
export function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
// One deterministic source/scene fingerprint shared by targeted, preview, and
// final renders.  Render settings are deliberately excluded: the environment
// recipe binds the supported profiles, while profile/run details belong to the
// profile fingerprint below.
export function inputFingerprint(manifest) {
  return sha256Json({
    inputAssets: manifest.inputAssets,
    // The checkout-relative audio path is profile-specific; bind the shared
    // source fingerprint to the bytes, not to the artifact's role/path.
    audio: manifest.audio ? { sha256: manifest.audio.sha256 } : null,
    usedUiAssets: manifest.usedUiAssets,
    shotlist: manifest.shotlist,
    environment: manifest.environment,
    uiCatalog: manifest.uiCatalog,
    scene: manifest.scene,
    cursor_track_provenance: manifest.cursor_track_provenance,
    blender: manifest.blender,
    toolInputs: manifest.toolInputs,
  });
}

const receiptKeys = {
  root: ["schemaVersion", "frames", "hashes", "provenance", "inputFingerprint", "reviewArtifacts"],
  frame: ["path", "sha256"],
  artifact: ["path", "sha256"],
  provenance: ["shotlist", "environment", "catalog", "scene"],
};

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error(`${label} has unknown or missing keys`);
}

function receiptHash(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
}

export function assertTargetedReviewReceipt(receipt, { schemaVersion = 2 } = {}) {
  exactKeys(receipt, receiptKeys.root, "targeted review receipt");
  if (receipt.schemaVersion !== schemaVersion) throw new Error(`targeted review receipt schemaVersion must be ${schemaVersion}`);
  exactKeys(receipt.frames, Object.keys(receipt.frames), "receipt.frames");
  exactKeys(receipt.hashes, Object.keys(receipt.hashes), "receipt.hashes");
  exactKeys(receipt.provenance, receiptKeys.provenance, "receipt.provenance");
  exactKeys(receipt.reviewArtifacts, ["blend", "manifest", "cursor", "audio"], "receipt.reviewArtifacts");
  receiptHash(receipt.inputFingerprint, "receipt.inputFingerprint");
  for (const [frame, entry] of Object.entries(receipt.frames)) {
    if (!/^\d+$/.test(frame)) throw new Error(`receipt frame key is invalid: ${frame}`);
    exactKeys(entry, receiptKeys.frame, `receipt.frames.${frame}`);
    receiptHash(entry.sha256, `receipt.frames.${frame}.sha256`);
    if (typeof entry.path !== "string" || path.isAbsolute(entry.path)) throw new Error(`receipt.frames.${frame}.path must be relative`);
  }
  exactKeys(receipt.hashes, Object.keys(receipt.frames), "receipt.hashes");
  for (const [frame, hash] of Object.entries(receipt.hashes)) receiptHash(hash, `receipt.hashes.${frame}`);
  for (const [name, value] of Object.entries(receipt.provenance)) receiptHash(value, `receipt.provenance.${name}`);
  for (const [name, entry] of Object.entries(receipt.reviewArtifacts)) {
    exactKeys(entry, receiptKeys.artifact, `receipt.reviewArtifacts.${name}`);
    receiptHash(entry.sha256, `receipt.reviewArtifacts.${name}.sha256`);
    if (typeof entry.path !== "string" || path.isAbsolute(entry.path)) throw new Error(`receipt.reviewArtifacts.${name}.path must be relative`);
  }
  for (const [frame, entry] of Object.entries(receipt.frames)) {
    if (receipt.hashes[frame] !== entry.sha256) throw new Error(`receipt frame/hash mismatch at ${frame}`);
  }
  return receipt;
}

const reviewPackageKeys = ["schemaVersion", "targetedReviewReceipt", "artifacts"];
const reviewPackageArtifactKeys = ["path", "sha256", "metadata"];

export function assertReviewPackageReceipt(receipt, { schemaVersion = 1 } = {}) {
  exactKeys(receipt, reviewPackageKeys, "review package receipt");
  if (receipt.schemaVersion !== schemaVersion) throw new Error(`review package receipt schemaVersion must be ${schemaVersion}`);
  exactKeys(receipt.targetedReviewReceipt, ["path", "sha256", "inputFingerprint"], "review package targeted receipt");
  if (receipt.targetedReviewReceipt.path !== "artifacts/skybao-film/provenance/targeted-review-receipt.json") throw new Error("review package targeted receipt path is not canonical");
  receiptHash(receipt.targetedReviewReceipt.sha256, "review package targeted receipt sha256");
  receiptHash(receipt.targetedReviewReceipt.inputFingerprint, "review package inputFingerprint");
  exactKeys(receipt.artifacts, ["reel", "contactSheet"], "review package artifacts");
  for (const [name, artifact] of Object.entries(receipt.artifacts)) {
    exactKeys(artifact, reviewPackageArtifactKeys, `review package ${name}`);
    if (typeof artifact.path !== "string" || path.isAbsolute(artifact.path)) throw new Error(`review package ${name}.path must be relative`);
    receiptHash(artifact.sha256, `review package ${name}.sha256`);
    if (!artifact.metadata || typeof artifact.metadata !== "object" || Array.isArray(artifact.metadata)) throw new Error(`review package ${name}.metadata must be an object`);
  }
  const reel = receipt.artifacts.reel.metadata;
  if (reel.width !== 1920 || reel.height !== 1080 || reel.codec !== "h264" || reel.pixFmt !== "yuv420p" || reel.fps !== 30 || !Number.isInteger(reel.frameCount) || reel.frameCount <= 0 || typeof reel.duration !== "number" || !Number.isFinite(reel.duration)) throw new Error("review package reel metadata is invalid");
  const sheet = receipt.artifacts.contactSheet.metadata;
  if (sheet.width !== 1920 || sheet.height !== 1080) throw new Error("review package contact sheet metadata is invalid");
  return receipt;
}

export function assertManifestInputsCurrent(manifest, { repo, environment, audioFile, configuredInputs } = {}) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest is invalid");
  const root = path.resolve(repo || ".");
  const recipe = environment || JSON.parse(fs.readFileSync(path.join(root, "frontend/scripts/video/film/environment.json"), "utf8"));
  const configured = new Map(Object.entries(configuredInputs || recipe.toolInputs || {}));
  for (const card of recipe.cloudCards || []) if (card?.source) configured.set(`cloudCard-${card.id}`, card.source);
  if (!configuredInputs) {
    configured.set("builder", "frontend/scripts/video/film/build-blender.py");
    configured.set("sceneContract", "frontend/scripts/video/film/scene-contract.py");
  }
  const inputAssets = manifest.inputAssets || {};
  for (const name of ["shotlist", "environment", "uiCatalog"]) if (!manifest[name]?.path) throw new Error(`${name} provenance is missing`);
  if (Object.keys(inputAssets).sort().join("\0") !== [...configured.keys()].sort().join("\0")) throw new Error("inputAssets do not exactly match configured provenance inputs");
  const check = (label, entry, override) => {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256 || "") || typeof entry.path !== "string" || path.isAbsolute(entry.path)) throw new Error(`${label} provenance is incomplete or not checkout-relative`);
    const file = override || path.resolve(root, entry.path);
    if (!fs.existsSync(file) || sha256(file) !== entry.sha256) throw new Error(`${label} is stale or missing`);
  };
  for (const name of ["shotlist", "environment", "uiCatalog"]) check(name, manifest[name]);
  for (const [name, relative] of configured) {
    if (inputAssets[name]?.path !== relative) throw new Error(`input ${name} path is not recipe-derived`);
    check(`input ${name}`, inputAssets[name]);
  }
  if (manifest.audio) check("audio", manifest.audio, audioFile);
  if (manifest.inputFingerprint && manifest.inputFingerprint !== inputFingerprint(manifest)) throw new Error("manifest input fingerprint does not match its current inputs");
  return manifest;
}

export function profileFingerprint(manifest) {
  return sha256Json({
    inputFingerprint: inputFingerprint(manifest),
    render: manifest.render || manifest.cycles || {},
  });
}

export function bindManifest(manifest) {
  manifest.inputFingerprint = inputFingerprint(manifest);
  manifest.profileFingerprint = profileFingerprint(manifest);
  return manifest;
}

export function assertCurrentProfileManifest(manifest, expectedInputFingerprint) {
  if (!manifest || manifest.schemaVersion !== 2 ||
      manifest.inputFingerprint !== expectedInputFingerprint ||
      inputFingerprint(manifest) !== expectedInputFingerprint ||
      manifest.profileFingerprint !== profileFingerprint(manifest))
    throw new Error("profile manifest is stale or not bound to the current inputs");
  return manifest;
}

export function assertCurrentRenderReport(report, expectedInputFingerprint, manifestSha256) {
  if (!report || report.schemaVersion !== 2 ||
      report.inputFingerprint !== expectedInputFingerprint ||
      report.provenance?.inputFingerprint !== expectedInputFingerprint ||
      report.provenance?.buildManifest?.sha256 !== manifestSha256)
    throw new Error("render report is stale or not bound to its profile manifest");
  return report;
}
