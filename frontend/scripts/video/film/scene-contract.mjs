#!/usr/bin/env node
"use strict";

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = process.env.BLENDER_BIN
  ? [process.env.BLENDER_BIN]
  : ["/Applications/Blender.app/Contents/MacOS/Blender", "blender"];
let blender = null;
for (const candidate of candidates) {
  const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  if (probe.status === 0) {
    blender = candidate;
    break;
  }
}
if (!blender) {
  console.error("scene-contract: cannot find Blender; set BLENDER_BIN");
  process.exit(2);
}
const userArgs = process.argv.slice(2);
const repoIndex = userArgs.indexOf("--repo");
const selectedRepo = repoIndex >= 0 ? path.resolve(userArgs[repoIndex + 1] || "") : null;
const contractScript = selectedRepo
  ? path.join(selectedRepo, "frontend", "scripts", "video", "film", "scene-contract.py")
  : path.join(here, "scene-contract.py");
if (selectedRepo && (!contractScript || !fs.existsSync(contractScript))) {
  console.error("scene-contract: selected repository has no compatible scene-contract.py");
  process.exit(2);
}
const blendIndex = userArgs.indexOf("--blend");
let blend = null;
if (blendIndex >= 0) {
  blend = userArgs[blendIndex + 1];
  if (!blend) {
    console.error("scene-contract: --blend requires a path");
    process.exit(2);
  }
  userArgs.splice(blendIndex, 2);
}
const result = spawnSync(blender, [
  "--background",
  ...(blend ? [blend] : []),
  "--python",
    contractScript,
  "--",
  ...userArgs,
], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
