// Builds the SkyBao frontend for the desktop wrapper and stages it where
// the production server expects it (server/public).
//
// This does the same two steps the Docker build performs:
//   1. `yarn build` in frontend/ with VITE_API_BASE=/api so the SPA talks
//      same-origin to the embedded server (instead of localhost:3001).
//   2. Copy frontend/dist/* -> server/public/ so the server's static handler
//      (registered when NODE_ENV !== "development") serves the SPA.
//
// Run with:  node desktop/scripts/build.js

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FRONTEND_DIR = path.join(REPO_ROOT, "frontend");
const DIST_DIR = path.join(FRONTEND_DIR, "dist");
const PUBLIC_DIR = path.join(REPO_ROOT, "server", "public");

function log(msg) {
  console.log(`[desktop:build] ${msg}`);
}

function fail(msg) {
  console.error(`[desktop:build] ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts, label) {
  log(`${label}...`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (result.status !== 0) {
    fail(`${label} failed (exit ${result.status}).`);
  }
}

// Recursive directory copy. fs.cpSync exists on Node 16.7+, which is well
// below this repo's Node floor.
function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function main() {
  if (!fs.existsSync(FRONTEND_DIR)) {
    fail(`frontend directory not found at ${FRONTEND_DIR}`);
  }
  if (!fs.existsSync(path.join(FRONTEND_DIR, "node_modules"))) {
    fail(
      "frontend/node_modules not found. Run `yarn setup` (or `cd frontend && yarn`) first."
    );
  }

  // 1. Build the SPA with the same-origin API base. Passing the var on the
  // command line takes precedence over frontend/.env for the duration of the
  // build only — it does not modify any file.
  log("Building frontend with VITE_API_BASE=/api ...");
  run(
    process.platform === "win32" ? "yarn.cmd" : "yarn",
    ["build"],
    {
      cwd: FRONTEND_DIR,
      env: { ...process.env, VITE_API_BASE: "/api" },
    },
    "vite build"
  );

  if (!fs.existsSync(DIST_DIR)) {
    fail(`frontend build did not produce ${DIST_DIR}`);
  }

  // 2. Stage the build into server/public.
  if (fs.existsSync(PUBLIC_DIR)) {
    log(`Cleaning existing ${path.relative(REPO_ROOT, PUBLIC_DIR)} ...`);
    fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  copyDir(DIST_DIR, PUBLIC_DIR);

  log(`Copied frontend/dist -> ${path.relative(REPO_ROOT, PUBLIC_DIR)}`);
  log("Done. Run `yarn desktop` to launch.");
}

main();
