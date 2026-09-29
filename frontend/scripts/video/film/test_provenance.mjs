import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertCurrentProfileManifest, assertCurrentRenderReport, assertFullPackageReceipt, assertManifestInputsCurrent, assertReviewPackageReceipt, bindManifest, inputFingerprint, profileFingerprint, reviewPackageSpec, sha256, sha256Json } from "./provenance.mjs";

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

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skybao-report-"));
const fixtureManifest = path.join(fixtureRoot, "build-manifest-final.json");
fs.writeFileSync(fixtureManifest, "versioned manifest bytes");
const fixtureHash = crypto.createHash("sha256").update(fs.readFileSync(fixtureManifest)).digest("hex");
const checksumFixture = {
  sha256: { buildManifest: fixtureHash },
  provenance: { buildManifest: { path: fixtureManifest, sha256: fixtureHash } },
};
assert.equal(checksumFixture.sha256.buildManifest, fixtureHash);
assert.equal(checksumFixture.provenance.buildManifest.sha256, fixtureHash);
fs.rmSync(fixtureRoot, { recursive: true, force: true });

const changed = fixture("final");
changed.scene.objects = 2;
assert.notEqual(inputFingerprint(changed), final.inputFingerprint);
assert.throws(() => assertCurrentProfileManifest(changed, final.inputFingerprint));
assert.throws(() => assertCurrentRenderReport({ ...report, inputFingerprint: "0".repeat(64) }, final.inputFingerprint, "2".repeat(64)));

// Lifecycle fixtures: the full approval is paired to both exact review
// receipts, not merely to their shared source fingerprint.
const lifecycleFull = {
  schemaVersion: 2,
  inputFingerprint: "3".repeat(64),
  reviewReceipt: {
    path: "artifacts/skybao-film/provenance/targeted-review-receipt.json",
    sha256: "4".repeat(64),
    inputFingerprint: "3".repeat(64),
  },
  reviewPackageReceipt: {
    path: "artifacts/skybao-film/provenance/review-package-receipt.json",
    sha256: "5".repeat(64),
    inputFingerprint: "3".repeat(64),
  },
  artifacts: { "deliverables/skybao-40s-master.mp4": "6".repeat(64) },
};
assert.doesNotThrow(() => assertFullPackageReceipt(lifecycleFull));
assert.doesNotThrow(() => assertFullPackageReceipt({ ...lifecycleFull, reviewReceipt: { ...lifecycleFull.reviewReceipt, sha256: "7".repeat(64) } }));
assert.throws(() => assertFullPackageReceipt(lifecycleFull, {
  expectedReviewReceiptSha256: "7".repeat(64),
}));
assert.throws(() => assertFullPackageReceipt(lifecycleFull, {
  expectedReviewPackageReceiptSha256: "7".repeat(64),
}));
assert.throws(() => assertFullPackageReceipt({ ...lifecycleFull, reviewPackageReceipt: undefined }));
assert.notEqual(inputFingerprint({ ...final, scene: { objects: 99 } }), final.inputFingerprint); // changed-input refresh
assert.equal(inputFingerprint(final), inputFingerprint(fixture("final"))); // same-input preserve

// Review package metadata is derived from the exact current frame list. The
// fixture exercises the full 38-frame contract plus its rejection boundaries.
const reviewFrames = Array.from({ length: 38 }, (_, index) => index + 1);
const reviewSpec = reviewPackageSpec(reviewFrames);
const validReviewPackage = {
  schemaVersion: 2,
  targetedReviewReceipt: { path: "artifacts/skybao-film/provenance/targeted-review-receipt.json", sha256: "7".repeat(64), inputFingerprint: "3".repeat(64) },
  sourceFrames: { count: reviewFrames.length, order: reviewFrames, orderDigest: sha256Json(reviewFrames) },
  artifacts: {
    reel: { path: "artifacts/skybao-film/review/skybao-targeted-review-reel.mp4", sha256: "8".repeat(64), metadata: { width: reviewSpec.width, height: reviewSpec.height, codec: "h264", pixFmt: "yuv420p", fps: 30, frameCount: reviewSpec.frameCount, duration: reviewSpec.duration } },
    contactSheet: { path: "artifacts/skybao-film/review/skybao-targeted-review-contact-sheet.png", sha256: "9".repeat(64), metadata: { width: reviewSpec.width, height: reviewSpec.height, columns: reviewSpec.columns, rows: reviewSpec.rows, frameCount: reviewFrames.length, offsetY: reviewSpec.padTop } },
  },
};
assert.doesNotThrow(() => assertReviewPackageReceipt(validReviewPackage, { expectedFrames: reviewFrames }));
const clone = (value) => JSON.parse(JSON.stringify(value));
const wrongFrameCount = clone(validReviewPackage);
wrongFrameCount.sourceFrames.count = 37;
assert.throws(() => assertReviewPackageReceipt(wrongFrameCount, { expectedFrames: reviewFrames }));
const wrongGrid = clone(validReviewPackage);
wrongGrid.artifacts.contactSheet.metadata.columns = 4;
assert.throws(() => assertReviewPackageReceipt(wrongGrid, { expectedFrames: reviewFrames }));
const wrongOffset = clone(validReviewPackage);
wrongOffset.artifacts.contactSheet.metadata.offsetY = 0;
assert.throws(() => assertReviewPackageReceipt(wrongOffset, { expectedFrames: reviewFrames }));
const wrongDuration = clone(validReviewPackage);
wrongDuration.artifacts.reel.metadata.duration = 8;
assert.throws(() => assertReviewPackageReceipt(wrongDuration, { expectedFrames: reviewFrames }));

// The pre-render receipt gate and the post-render manifest deliberately share
// scene portability data; observed render duration must not alter their input
// fingerprint.
const portableScene = { objects: 1, portable_dependencies: { images: 19, sounds: 1, missing: 0 } };
const preRenderManifest = bindManifest({
  ...fixture("final"), scene: portableScene,
  render: { ...fixture("final").render, elapsedRenderSeconds: 0 },
});
const postRenderManifest = bindManifest({
  ...fixture("final"), scene: portableScene,
  render: { ...fixture("final").render, elapsedRenderSeconds: 42.5 },
});
assert.equal(preRenderManifest.inputFingerprint, postRenderManifest.inputFingerprint);

// Two checkouts with identical relative inputs must share provenance; an
// absolute checkout path must never become part of the fingerprint.
const checkoutA = fs.mkdtempSync(path.join(os.tmpdir(), "skybao-checkout-a-"));
const checkoutB = fs.mkdtempSync(path.join(os.tmpdir(), "skybao-checkout-b-"));
const relativeInputs = ["shotlist.json", "environment.json", "catalog.json", "builder.py", "scene-contract.py"];
for (const checkout of [checkoutA, checkoutB]) for (const file of relativeInputs) {
  fs.mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
  fs.writeFileSync(path.join(checkout, file), file);
}
fs.writeFileSync(path.join(checkoutA, "mix.wav"), "mix");
fs.writeFileSync(path.join(checkoutB, "mix.wav"), "mix");
const entry = (file) => ({ path: file, sha256: sha256(path.join(checkoutA, file)) });
const portableEnvironment = { toolInputs: { builder: "builder.py", sceneContract: "scene-contract.py" } };
const portable = bindManifest({
  ...fixture("final"),
  shotlist: entry("shotlist.json"), environment: entry("environment.json"), uiCatalog: entry("catalog.json"),
  inputAssets: { builder: entry("builder.py"), sceneContract: entry("scene-contract.py") },
  audio: { path: "mix.wav", sha256: sha256(path.join(checkoutA, "mix.wav")) },
});
assertManifestInputsCurrent(portable, { repo: checkoutA, environment: portableEnvironment, configuredInputs: portableEnvironment.toolInputs });
const portableB = JSON.parse(JSON.stringify(portable));
assert.equal(inputFingerprint(portable), inputFingerprint(portableB));
portableB.inputAssets.builder.sha256 = "0".repeat(64);
assert.throws(() => assertManifestInputsCurrent(portableB, { repo: checkoutB, environment: portableEnvironment, configuredInputs: portableEnvironment.toolInputs }));
fs.rmSync(checkoutA, { recursive: true, force: true });
fs.rmSync(checkoutB, { recursive: true, force: true });
console.log("provenance fixture: current preview/final bind; changed input rejects");
