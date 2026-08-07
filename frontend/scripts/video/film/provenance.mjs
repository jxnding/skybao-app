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
