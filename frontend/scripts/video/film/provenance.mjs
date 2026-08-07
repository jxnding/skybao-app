import crypto from "crypto";
import fs from "fs";

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
    executed: manifest.executed,
    inputAssets: manifest.inputAssets,
    audio: manifest.audio,
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
