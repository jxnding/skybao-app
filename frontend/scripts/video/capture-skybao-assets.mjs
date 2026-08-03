#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import puppeteer from "puppeteer";
import {
  ALL_ASSETS,
  MOTION_ASSETS,
  STILL_ASSETS,
  VIDEO_SETTINGS,
} from "./skybao-assets.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(scriptDirectory, "../..");
const repositoryDirectory = path.resolve(frontendDirectory, "..");
const defaultOutput = path.join(repositoryDirectory, "artifacts/skybao-ui");
const defaultSmokeOutput = path.join(
  repositoryDirectory,
  "artifacts/skybao-ui-smoke"
);
const outputSentinel = ".skybao-video-assets";

function parseArguments(argv) {
  const options = {
    baseUrl: "",
    build: true,
    clipsOnly: false,
    only: null,
    output: defaultOutput,
    outputExplicit: false,
    smoke: false,
    stillsOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.split(/=(.*)/s, 2);
    const nextValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value.`);
      return argv[index];
    };

    if (flag === "--base-url") options.baseUrl = nextValue();
    else if (flag === "--out") {
      options.output = path.resolve(nextValue());
      options.outputExplicit = true;
    } else if (flag === "--only") {
      options.only = new Set(
        nextValue()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      );
    } else if (flag === "--skip-build") options.build = false;
    else if (flag === "--stills-only") options.stillsOnly = true;
    else if (flag === "--clips-only") options.clipsOnly = true;
    else if (flag === "--smoke") options.smoke = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }

  if (options.stillsOnly && options.clipsOnly)
    throw new Error("Choose either --stills-only or --clips-only, not both.");

  if (options.smoke && !options.outputExplicit)
    options.output = defaultSmokeOutput;

  return options;
}

function printHelp() {
  process.stdout.write(`SkyBao video asset generator\n\n`);
  process.stdout.write(`Usage: yarn video:assets [options]\n\n`);
  process.stdout.write(
    `  --only=<id,id>       Capture selected manifest IDs\n`
  );
  process.stdout.write(`  --out=<path>         Override artifacts/skybao-ui\n`);
  process.stdout.write(`  --stills-only        Capture only baseline stills\n`);
  process.stdout.write(`  --clips-only         Capture only motion clips\n`);
  process.stdout.write(
    `  --smoke              Capture start/middle/end frames in a separate smoke directory\n`
  );
  process.stdout.write(
    `  --skip-build         Reuse the existing frontend build\n`
  );
  process.stdout.write(
    `  --base-url=<url>     Reuse a running frontend instead of Vite preview\n`
  );
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}.`));
    });
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`Preview returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Preview did not become ready: ${lastError?.message || url}`);
}

async function startPreview(options) {
  if (options.baseUrl) {
    await waitForServer(options.baseUrl);
    return { baseUrl: options.baseUrl, server: null };
  }

  if (options.build)
    await run("yarn", ["build"], frontendDirectory, {
      ...process.env,
      VITE_SKYBAO_CAPTURE: "1",
    });

  const dist = path.join(frontendDirectory, "dist");
  const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".webm": "video/webm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname.startsWith("/api/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          requestUrl.pathname === "/api/setup-complete"
            ? JSON.stringify({
                results: { MultiUserMode: false, RequiresAuth: false },
              })
            : "{}"
        );
        return;
      }

      const requestedPath = decodeURIComponent(requestUrl.pathname);
      const relativePath = requestedPath.replace(/^\/+/, "");
      let file = path.resolve(dist, relativePath);
      if (!file.startsWith(`${dist}${path.sep}`) && file !== dist)
        throw new Error("Invalid preview path.");

      const fileStats = await stat(file).catch(() => null);
      if (!fileStats?.isFile()) file = path.join(dist, "_index.html");
      const body = await readFile(file);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type":
          mimeTypes[path.extname(file)] || "application/octet-stream",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await waitForServer(baseUrl);
  return { baseUrl, server };
}

async function resetOutputDirectory(output) {
  try {
    const entries = await readdir(output);
    if (entries.length > 0) {
      await access(path.join(output, outputSentinel)).catch(() => {
        throw new Error(
          `Refusing to replace non-artifact directory: ${output}\n` +
            `Choose an empty --out path or remove its contents manually.`
        );
      });
    }
    await rm(output, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, outputSentinel),
    "Generated by frontend/scripts/video/capture-skybao-assets.mjs\n"
  );
}

function selectedAssets(options) {
  if (options.only) {
    const known = new Set(ALL_ASSETS.map((asset) => asset.id));
    const unknown = [...options.only].filter((id) => !known.has(id));
    if (unknown.length > 0)
      throw new Error(`Unknown asset ID(s): ${unknown.join(", ")}`);
  }

  const matches = (asset) => !options.only || options.only.has(asset.id);
  return {
    stills: options.clipsOnly ? [] : STILL_ASSETS.filter(matches),
    clips: options.stillsOnly ? [] : MOTION_ASSETS.filter(matches),
  };
}

function captureUrl(baseUrl, asset, framing) {
  const url = new URL(asset.route, baseUrl);
  url.searchParams.set("capture", "transparent");
  url.searchParams.set("artifact", "1");
  url.searchParams.set("framing", framing);
  url.searchParams.set("state", asset.state);
  return url.toString();
}

async function waitForCapture(page) {
  await page.waitForFunction(() => window.__SKYBAO_CAPTURE__?.ready === true, {
    timeout: 20_000,
  });
  await page.waitForSelector('[data-capture-id="app-shell"]', {
    visible: true,
    timeout: 20_000,
  });
}

async function preparePage(page, baseUrl, asset, framing) {
  await page.goto(captureUrl(baseUrl, asset, framing), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await waitForCapture(page);
  await page.waitForSelector(
    asset.area === "assistant"
      ? '[data-capture-id="assistant-root"]'
      : '[data-capture-id="native-area-root"]',
    { visible: true, timeout: 20_000 }
  );
  await page.evaluate(async () => {
    sessionStorage.clear();
    await window.__SKYBAO_CAPTURE__.setFrame(0);
  });
}

function selectorFor(target) {
  return `[data-capture-id="${target}"]`;
}

async function targetCenter(page, target) {
  const selector = selectorFor(target);
  await page.waitForSelector(selector, { visible: true, timeout: 10_000 });
  return page.$eval(selector, (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

function cursorEntry(frame, point, event) {
  return {
    frame,
    x: Math.round(point.x * 100) / 100,
    y: Math.round(point.y * 100) / 100,
    nx: Math.round((point.x / VIDEO_SETTINGS.width) * 100_000) / 100_000,
    ny: Math.round((point.y / VIDEO_SETTINGS.height) * 100_000) / 100_000,
    event,
  };
}

async function executeFrameActions(page, asset, frame, runtime, cursor) {
  for (let index = 0; index < asset.actions.length; index += 1) {
    const action = asset.actions[index];
    const state = runtime.get(index) || {};

    if (action.type === "click" && action.frame === frame) {
      const point = await targetCenter(page, action.target);
      cursor.push(cursorEntry(frame, point, "click"));
      const previousUrl = page.url();
      await page.click(selectorFor(action.target));
      if (action.navigation) {
        await page.waitForFunction(
          (url) => window.location.href !== url,
          { timeout: 10_000 },
          previousUrl
        );
        await waitForCapture(page);
        await page.evaluate(
          (currentFrame) => window.__SKYBAO_CAPTURE__.setFrame(currentFrame),
          frame
        );
      }
      runtime.set(index, { ...state, complete: true });
    }

    if (action.type === "select" && action.frame === frame) {
      const point = await targetCenter(page, action.target);
      cursor.push(cursorEntry(frame, point, "click"));
      await page.select(selectorFor(action.target), action.value);
      runtime.set(index, { ...state, complete: true });
    }

    if (
      action.type === "type" &&
      frame >= action.startFrame &&
      frame <= action.endFrame
    ) {
      if (!state.focused) {
        const point = await targetCenter(page, action.target);
        cursor.push(cursorEntry(frame, point, "click"));
        await page.$eval(selectorFor(action.target), (element) => {
          element.focus();
          if (typeof element.setSelectionRange === "function") {
            const end = element.value.length;
            element.setSelectionRange(end, end);
          }
        });
        state.focused = true;
        state.typed = 0;
      }

      const range = Math.max(1, action.endFrame - action.startFrame);
      const progress = Math.min(1, (frame - action.startFrame) / range);
      const desiredLength = Math.floor(progress * action.text.length);
      if (desiredLength > state.typed) {
        const chunk = action.text.slice(state.typed, desiredLength);
        await page.keyboard.type(chunk);
        state.typed = desiredLength;
      }
      runtime.set(index, state);
    }

    if (
      action.type === "drag" &&
      frame >= action.startFrame &&
      frame <= action.endFrame
    ) {
      if (!state.started) {
        state.start = await targetCenter(page, action.target);
        state.end = await targetCenter(page, action.destination);
        await page.mouse.move(state.start.x, state.start.y);
        await page.mouse.down();
        cursor.push(cursorEntry(frame, state.start, "down"));
        state.started = true;
      }
      const range = Math.max(1, action.endFrame - action.startFrame);
      const progress = Math.min(1, (frame - action.startFrame) / range);
      const point = {
        x: state.start.x + (state.end.x - state.start.x) * progress,
        y: state.start.y + (state.end.y - state.start.y) * progress,
      };
      await page.mouse.move(point.x, point.y);
      cursor.push(cursorEntry(frame, point, "move"));
      if (frame === action.endFrame) {
        await page.mouse.up();
        cursor.push(cursorEntry(frame, point, "up"));
        state.complete = true;
      }
      runtime.set(index, state);
    }
  }
}

async function screenshot(page, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const png = await page.screenshot({
    type: "png",
    omitBackground: true,
    captureBeyondViewport: false,
  });
  await writeFile(outputPath, normalizeTransparentPng(Buffer.from(png)));
}

async function captureStill(page, baseUrl, output, asset, framing, catalog) {
  await preparePage(page, baseUrl, asset, framing);
  const relativePath = path.join(
    "stills",
    framing,
    asset.area,
    `${asset.id}.png`
  );
  await screenshot(page, path.join(output, relativePath));
  catalog.push({
    ...asset,
    framing,
    file: relativePath.split(path.sep).join("/"),
    width: VIDEO_SETTINGS.width,
    height: VIDEO_SETTINGS.height,
  });
  process.stdout.write(`still  ${framing.padEnd(9)} ${asset.id}\n`);
}

function sampledFrames(asset, smoke) {
  if (!smoke)
    return new Set(
      Array.from({ length: asset.frameCount }, (_, index) => index)
    );
  return new Set([
    0,
    Math.floor((asset.frameCount - 1) / 2),
    asset.frameCount - 1,
  ]);
}

async function captureClip(page, baseUrl, output, asset, smoke, catalog) {
  await preparePage(page, baseUrl, asset, "workspace");
  const clipDirectory = path.join("clips", asset.area, asset.id);
  const outputFrames = sampledFrames(asset, smoke);
  const runtime = new Map();
  const cursor = [];
  const captured = [];

  for (let frame = 0; frame < asset.frameCount; frame += 1) {
    await page.evaluate(
      (nextFrame) => window.__SKYBAO_CAPTURE__.setFrame(nextFrame),
      frame
    );
    await executeFrameActions(page, asset, frame, runtime, cursor);

    if (outputFrames.has(frame)) {
      const filename = `frame-${String(frame + 1).padStart(6, "0")}.png`;
      await screenshot(page, path.join(output, clipDirectory, filename));
      captured.push({ frame, file: filename });
    }

    if (frame === 0 || frame === asset.frameCount - 1) {
      const suffix = frame === 0 ? "start" : "end";
      await screenshot(
        page,
        path.join(
          output,
          "stills",
          "workspace",
          asset.area,
          `${asset.id}-${suffix}.png`
        )
      );
    }
  }

  const timeline = {
    id: asset.id,
    fps: VIDEO_SETTINGS.fps,
    frameCount: asset.frameCount,
    durationSeconds: asset.durationSeconds,
    sampled: smoke,
    capturedFrames: captured,
    cursor,
  };
  await writeFile(
    path.join(output, clipDirectory, "timeline.json"),
    `${JSON.stringify(timeline, null, 2)}\n`
  );
  for (const suffix of ["start", "end"]) {
    const stillPath = path.join(
      "stills",
      "workspace",
      asset.area,
      `${asset.id}-${suffix}.png`
    );
    catalog.push({
      id: `${asset.id}-${suffix}`,
      area: asset.area,
      label: `${asset.label} · ${suffix}`,
      route: asset.route,
      state: asset.state,
      type: "still",
      framing: "workspace",
      file: stillPath.split(path.sep).join("/"),
      width: VIDEO_SETTINGS.width,
      height: VIDEO_SETTINGS.height,
      derivedFrom: asset.id,
    });
  }
  catalog.push({
    ...asset,
    actions: undefined,
    framing: "workspace",
    directory: clipDirectory.split(path.sep).join("/"),
    timeline: path
      .join(clipDirectory, "timeline.json")
      .split(path.sep)
      .join("/"),
    sampled: smoke,
    capturedFrames: captured.length,
    width: VIDEO_SETTINGS.width,
    height: VIDEO_SETTINGS.height,
    fps: VIDEO_SETTINGS.fps,
  });
  process.stdout.write(
    `clip   workspace ${asset.id} (${captured.length}/${asset.frameCount} frames)\n`
  );
}

function contactSheetHtml(entries) {
  const cards = entries
    .filter((entry) => entry.type === "still")
    .map(
      (entry) => `<figure>
  <div><img src="${entry.file}" alt="${entry.label.replaceAll('"', "&quot;")}"></div>
  <figcaption><b>${entry.label}</b><span>${entry.framing} · ${entry.id}</span></figcaption>
</figure>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SkyBao UI asset contact sheet</title>
<style>
body{margin:0;padding:32px;background:#070b14;color:#eef4ff;font:14px Inter,system-ui,sans-serif}h1{margin:0 0 8px;font-size:28px}p{margin:0 0 28px;color:#9aacbf}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:20px}figure{margin:0;border:1px solid #283449;border-radius:14px;overflow:hidden;background:#111827}figure>div{background-color:#d9dde5;background-image:linear-gradient(45deg,#bfc5cf 25%,transparent 25%),linear-gradient(-45deg,#bfc5cf 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#bfc5cf 75%),linear-gradient(-45deg,transparent 75%,#bfc5cf 75%);background-size:24px 24px;background-position:0 0,0 12px,12px -12px,-12px 0}img{display:block;width:100%;height:auto}figcaption{display:flex;justify-content:space-between;gap:16px;padding:12px 14px}figcaption span{color:#91a0b6}
</style>
<h1>SkyBao UI asset contact sheet</h1>
<p>Dark-mode, 1920×1080, transparent RGBA capture library.</p>
<main class="grid">${cards}</main>
</html>\n`;
}

function readPngInfo(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature)
    throw new Error("Invalid PNG signature.");
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  if (!width || !height || bitDepth !== 8 || colorType !== 6)
    throw new Error(
      `Expected an 8-bit RGBA PNG, received ${width}x${height} depth=${bitDepth} type=${colorType}.`
    );
  return { width, height, compressed: Buffer.concat(idat) };
}

function paeth(a, b, c) {
  const prediction = a + b - c;
  const pa = Math.abs(prediction - a);
  const pb = Math.abs(prediction - b);
  const pc = Math.abs(prediction - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buffer) {
  const { width, height, compressed } = readPngInfo(buffer);
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(compressed);
  const rows = [];
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[offset];
    offset += 1;
    const raw = inflated.subarray(offset, offset + stride);
    offset += stride;
    const row = Buffer.allocUnsafe(stride);
    const previous = rows[y - 1];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = previous ? previous[x] : 0;
      const upperLeft =
        previous && x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      if (filter === 0) row[x] = raw[x];
      else if (filter === 1) row[x] = (raw[x] + left) & 255;
      else if (filter === 2) row[x] = (raw[x] + up) & 255;
      else if (filter === 3)
        row[x] = (raw[x] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4)
        row[x] = (raw[x] + paeth(left, up, upperLeft)) & 255;
      else throw new Error(`Unsupported PNG filter ${filter}.`);
    }
    rows.push(row);
  }
  return { width, height, pixels: Buffer.concat(rows) };
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1)
    current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1)
    pixels.copy(
      scanlines,
      row * (stride + 1) + 1,
      row * stride,
      (row + 1) * stride
    );
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function normalizeTransparentPng(buffer) {
  const { width, height, pixels } = decodePng(buffer);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] !== 0) continue;
    pixels[offset] = 0;
    pixels[offset + 1] = 0;
    pixels[offset + 2] = 0;
  }
  return encodePng(width, height, pixels);
}

function cornerAlphas(buffer) {
  const { width, height, pixels } = decodePng(buffer);
  const alphaAt = (x, y) => pixels[(y * width + x) * 4 + 3];
  return {
    width,
    height,
    alphas: [
      alphaAt(0, 0),
      alphaAt(width - 1, 0),
      alphaAt(0, height - 1),
      alphaAt(width - 1, height - 1),
    ],
  };
}

async function validatePng(file) {
  const info = cornerAlphas(await readFile(file));
  if (
    info.width !== VIDEO_SETTINGS.width ||
    info.height !== VIDEO_SETTINGS.height
  )
    throw new Error(`Unexpected PNG dimensions for ${file}.`);
  if (!info.alphas.some((alpha) => alpha === 0))
    throw new Error(`No transparent corner found in ${file}.`);
}

async function validateOutput(output, catalog) {
  for (const entry of catalog) {
    if (entry.type === "still") {
      await validatePng(path.join(output, entry.file));
      continue;
    }

    const timeline = JSON.parse(
      await readFile(path.join(output, entry.timeline), "utf8")
    );
    if (timeline.frameCount !== entry.frameCount)
      throw new Error(`Timeline frame count mismatch for ${entry.id}.`);
    if (!entry.sampled && timeline.capturedFrames.length !== entry.frameCount)
      throw new Error(`Missing frames for ${entry.id}.`);
    if (!entry.sampled) {
      timeline.capturedFrames.forEach(({ frame }, index) => {
        if (frame !== index)
          throw new Error(`Non-contiguous frames for ${entry.id}.`);
      });
    }
    for (const event of timeline.cursor) {
      if (event.nx < 0 || event.nx > 1 || event.ny < 0 || event.ny > 1)
        throw new Error(`Cursor event outside the viewport for ${entry.id}.`);
    }
    const first = timeline.capturedFrames[0]?.file;
    const last = timeline.capturedFrames.at(-1)?.file;
    if (!first || !last) throw new Error(`No captured frames for ${entry.id}.`);
    await validatePng(path.join(output, entry.directory, first));
    if (last !== first)
      await validatePng(path.join(output, entry.directory, last));
  }
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === outputSentinel || entry.name === "checksums.sha256")
      continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute)));
    else files.push(absolute);
  }
  return files;
}

async function writeChecksums(output) {
  const files = (await listFiles(output)).sort();
  const lines = [];
  for (const file of files) {
    const digest = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    lines.push(
      `${digest}  ${path.relative(output, file).split(path.sep).join("/")}`
    );
  }
  await writeFile(
    path.join(output, "checksums.sha256"),
    `${lines.join("\n")}\n`
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const assets = selectedAssets(options);
  if (assets.stills.length === 0 && assets.clips.length === 0)
    throw new Error("No assets matched the requested filters.");

  await resetOutputDirectory(options.output);
  const preview = await startPreview(options);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      defaultViewport: {
        width: VIDEO_SETTINGS.width,
        height: VIDEO_SETTINGS.height,
        deviceScaleFactor: 1,
      },
      args: [
        "--force-color-profile=srgb",
        "--font-render-hinting=none",
        "--hide-scrollbars",
      ],
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.setDefaultTimeout(15_000);

    const catalogEntries = [];
    for (const asset of assets.stills) {
      await captureStill(
        page,
        preview.baseUrl,
        options.output,
        asset,
        "shell",
        catalogEntries
      );
      await captureStill(
        page,
        preview.baseUrl,
        options.output,
        asset,
        "workspace",
        catalogEntries
      );
    }
    for (const asset of assets.clips) {
      await captureClip(
        page,
        preview.baseUrl,
        options.output,
        asset,
        options.smoke,
        catalogEntries
      );
    }

    if (pageErrors.length > 0)
      throw new Error(
        `Browser errors:\n${pageErrors.map((error) => `- ${error}`).join("\n")}`
      );

    await mkdir(path.join(options.output, "cursor"), { recursive: true });
    await copyFile(
      path.join(scriptDirectory, "cursor.svg"),
      path.join(options.output, "cursor/cursor.svg")
    );
    const catalog = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      generator: "frontend/scripts/video/capture-skybao-assets.mjs",
      settings: VIDEO_SETTINGS,
      sampled: options.smoke,
      assets: catalogEntries,
    };
    await writeFile(
      path.join(options.output, "catalog.json"),
      `${JSON.stringify(catalog, null, 2)}\n`
    );
    await writeFile(
      path.join(options.output, "contact-sheet.html"),
      contactSheetHtml(catalogEntries)
    );
    await validateOutput(options.output, catalogEntries);
    await writeChecksums(options.output);
    process.stdout.write(
      `\nValidated ${catalogEntries.length} catalog entries.\n`
    );
    process.stdout.write(`Artifact: ${options.output}\n`);
  } finally {
    if (browser) await browser.close();
    if (preview.server)
      await new Promise((resolve) => preview.server.close(resolve));
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
