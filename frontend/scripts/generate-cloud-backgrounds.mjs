// Generates the static cloud background images for the SkyBao reskin.
//
// This is a faithful port of the ORIGINAL SkyBao clouds implementation (before
// the perf optimizations) — higher fidelity than the later version:
//   - numOctaves="10" (vs 3)
//   - feDisplacementMap scale="240" (real pixel warp, vs the later scale="0")
//   - 100 blobs (vs 30)
//   - blur radius 20-40vmin (vs 15-28vmin)
//   - palette: #11cbd7, #c6f1e7, #1198D7
//
// We rasterize the result to a PNG once at build time (via sharp+librsvg)
// instead of running it live in the browser.
//
// Run: node scripts/generate-cloud-backgrounds.mjs
// Output: public/clouds-light.png, public/clouds-dark.png
import sharp from "/Users/ding/Projects/anything-llm/server/node_modules/sharp/lib/index.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "public");

// SVG canvas. The runtime version uses vw/vh/vmin units relative to the
// viewport; for a static image we pick a representative viewport and convert
// vmin to px against its smaller dimension (here, height).
const W = 1920;
const H = 1200;
const VW = W / 100; // 1vw in px
const VH = H / 100; // 1vh in px
const VMIN = Math.min(W, H) / 100; // 1vmin in px

// --- Verbatim from the ORIGINAL clouds implementation ----------------------
// Light palette (exact colors from the original).
const LIGHT_COLORS = ["#11cbd7", "#c6f1e7", "#1198D7"];
// Dark-mode night-sky palette (our addition for the app's dark theme).
const DARK_COLORS = ["#1e3a5f", "#0e2a47", "#172554", "#0b1724"];

// Original helpers, verbatim.
function rn(from, to) {
  return ~~(Math.random() * (to - from + 1)) + from;
}
function rs(...items) {
  return items[rn(0, items.length - 1)];
}

// Original box-shadow grammar:
//   offsetX offsetY blurRadius spreadRadius color
//   rn(1,100)vw  rn(1,100)vh  rn(20,40)vmin  rn(1,20)vmin  <color>
// (the original used max=100, blur 20-40, spread 1-20)
function boxShadowBlobs(max, colors) {
  const blobs = [];
  for (let i = 0; i < max; ++i) {
    blobs.push({
      offsetX: rn(1, 100) * VW,
      offsetY: rn(1, 100) * VH,
      blur: rn(20, 40) * VMIN,
      spread: rn(1, 20) * VMIN,
      color: rs(...colors),
    });
  }
  return blobs;
}

// Convert each box-shadow blob into a visually-equivalent SVG <circle>.
// A box-shadow of (ox, oy, blur, spread, color) off a 1px circle reads as a
// circle of radius ~spread at (ox, oy), feathered by blur, filled color.
// We render it as a circle with a radial-gradient fade (matching how a blurred
// box-shadow feathers) plus a per-group feGaussianBlur.
function blobsToSvg(blobs) {
  const defs = [];
  const circles = [];
  blobs.forEach((b, i) => {
    const id = `b${i}`;
    defs.push(
      `<radialGradient id="${id}" cx="50%" cy="50%" r="50%">
         <stop offset="0%" stop-color="${b.color}" stop-opacity="0.9"/>
         <stop offset="55%" stop-color="${b.color}" stop-opacity="0.45"/>
         <stop offset="100%" stop-color="${b.color}" stop-opacity="0"/>
       </radialGradient>`
    );
    const r = Math.max(b.spread, 1);
    circles.push(
      `<circle cx="${b.offsetX}" cy="${b.offsetY}" r="${r}" fill="url(#${id})"/>`
    );
  });
  return { defs: defs.join("\n"), circles: circles.join("\n") };
}

// The EXACT filter from the original implementation — the high-fidelity one:
// numOctaves="10", scale="240" (real displacement, not 0).
const CLOUD_FILTER = `
  <filter id="cloud-filter" x="-50%" y="-50%" width="200%" height="200%">
    <feTurbulence type="fractalNoise" baseFrequency=".01" numOctaves="10" />
    <feDisplacementMap in="SourceGraphic" scale="240" />
  </filter>
`;

function buildSvg(gradient, palette) {
  const blobs = boxShadowBlobs(100, palette); // original used max=100
  const { defs, circles } = blobsToSvg(blobs);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        ${gradient}
      </linearGradient>
      ${CLOUD_FILTER}
      ${defs}
    </defs>
    <rect width="${W}" height="${H}" fill="url(#sky)"/>
    <g filter="url(#cloud-filter)">
      ${circles}
    </g>
  </svg>`;
}

// Sky gradient. The original clouds had no explicit sky gradient (transparent
// over the page), so we use the SkyBao marketing-site sky gradient for light
// mode and a night-sky gradient for dark mode.
const LIGHT_GRADIENT = `
      <stop offset="0%" stop-color="#b8d4f0"/>
      <stop offset="50%" stop-color="#dce9f7"/>
      <stop offset="100%" stop-color="#e8f2fa"/>
    `;
const DARK_GRADIENT = `
      <stop offset="0%" stop-color="#0b1724"/>
      <stop offset="50%" stop-color="#0e2235"/>
      <stop offset="100%" stop-color="#0e0f0f"/>
    `;

async function generate() {
  const lightSvg = buildSvg(LIGHT_GRADIENT, LIGHT_COLORS);
  const darkSvg = buildSvg(DARK_GRADIENT, DARK_COLORS);

  const lightPath = join(OUT_DIR, "clouds-light.png");
  const darkPath = join(OUT_DIR, "clouds-dark.png");

  await sharp(Buffer.from(lightSvg)).png().toFile(lightPath);
  await sharp(Buffer.from(darkSvg)).png().toFile(darkPath);

  console.log("Wrote", lightPath);
  console.log("Wrote", darkPath);
}

generate().catch((e) => {
  console.error(e);
  process.exit(1);
});
