import assert from "node:assert/strict";
import { assertCurrentProfileManifest, assertCurrentRenderReport, bindManifest, inputFingerprint, profileFingerprint } from "./provenance.mjs";

// Fast fixture for the handoff contract. This deliberately constructs the same
// profile-manifest/report envelope without invoking Blender or encoding frames.
function fixture(profile) {
  return bindManifest({
    schemaVersion: 2,
    shotlist: { path: "shotlist.json", sha256: "a".repeat(64) },
    environment: { path: "environment.json", sha256: "b".repeat(64) },
    uiCatalog: { path: "catalog.json", sha256: "c".repeat(64) },
    inputAssets: { scene: { path: "scene.py", sha256: "d".repeat(64) } },
    usedUiAssets: [{ id: "ui", contentSha256: "e".repeat(64) }],
    audio: { path: "mix.wav", sha256: "f".repeat(64) },
    blender: { engine: "CYCLES", version: "test" },
    scene: { objects: 1 },
    render: { profile, samples: profile === "preview" ? 32 : 128, elapsedRenderSeconds: profile === "preview" ? 1 : 2 },
  });
}

const preview = fixture("preview");
const final = fixture("final");
assert.equal(preview.inputFingerprint, final.inputFingerprint);
assert.notEqual(preview.profileFingerprint, final.profileFingerprint);
assert.equal(inputFingerprint(preview), preview.inputFingerprint);
assert.equal(profileFingerprint(final), final.profileFingerprint);

const versioned = { ...final, artifacts: { blend: { sha256: "1".repeat(64) } } };
const report = {
  schemaVersion: 2,
  inputFingerprint: versioned.inputFingerprint,
  provenance: {
    inputFingerprint: versioned.inputFingerprint,
    buildManifest: { sha256: "2".repeat(64) },
  },
};
assertCurrentProfileManifest(final, preview.inputFingerprint);
assertCurrentRenderReport(report, final.inputFingerprint, "2".repeat(64));

const changed = fixture("final");
changed.scene.objects = 2;
assert.notEqual(inputFingerprint(changed), final.inputFingerprint);
assert.throws(() => assertCurrentProfileManifest(changed, final.inputFingerprint));
assert.throws(() => assertCurrentRenderReport({ ...report, inputFingerprint: "0".repeat(64) }, final.inputFingerprint, "2".repeat(64)));
console.log("provenance fixture: current preview/final bind; changed input rejects");
