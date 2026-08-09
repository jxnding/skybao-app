#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { assertManifestInputsCurrent, assertTargetedReviewReceipt, inputFingerprint } from "./provenance.mjs";
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`missing ${name}`); return args[i + 1]; };
const repo = path.resolve(value("--repo"));
const manifest = JSON.parse(fs.readFileSync(value("--manifest"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(value("--receipt"), "utf8"));
assertTargetedReviewReceipt(receipt);
const audioIndex = args.indexOf("--audio");
assertManifestInputsCurrent(manifest, { repo, audioFile: audioIndex >= 0 ? args[audioIndex + 1] : undefined });
if (receipt.inputFingerprint !== inputFingerprint(manifest)) throw new Error("approved targeted receipt does not match the new build fingerprint");
console.log("receipt gate: current manifest and approved receipt match");
