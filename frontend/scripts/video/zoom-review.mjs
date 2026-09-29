#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  readFile,
  mkdir,
  readdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer";
import { MOTION_ASSETS, VIDEO_SETTINGS } from "./skybao-assets.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(scriptDirectory, "../..");
const repositoryDirectory = path.resolve(frontendDirectory, "..");
const canonicalDirectory = path.join(repositoryDirectory, "artifacts/skybao-ui");
const defaultOutput = path.join(repositoryDirectory, "artifacts/skybao-ui-zoom-review");
const outputSentinel = ".skybao-zoom-review";
const physical = { width: 1920, height: 1080 };
const zoomLevels = [
  { percent: 100, width: 1920, height: 1080, dpr: 1 },
  { percent: 125, width: 1536, height: 864, dpr: 1.25 },
  { percent: 150, width: 1280, height: 720, dpr: 1.5 },
  { percent: 175, width: 1097, height: 617, dpr: 1.75 },
  { percent: 200, width: 960, height: 540, dpr: 2 },
];
const targets = [
  { assetId: "assistant-research", frame: 83 },
  { assetId: "knowledge-file-search", frame: 90 },
  { assetId: "communications-draft-review", frame: 120 },
  { assetId: "work-board-drag", frame: 120 },
  { assetId: "admin-privacy-to-users", frame: 90 },
];

function parseArgs(argv) {
  const options = { out: defaultOutput, baseUrl: "", build: true };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split(/=(.*)/s, 2);
    const next = () => inline ?? argv[++index];
    if (flag === "--out") options.out = path.resolve(next());
    else if (flag === "--base-url") options.baseUrl = next();
    else if (flag === "--skip-build") options.build = false;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argv[index]}`);
  }
  return options;
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? signal}`))
    );
  });
}

async function resetOutputDirectory(output) {
  const resolved = path.resolve(output);
  const filesystemRoot = path.parse(resolved).root;
  if (
    resolved === filesystemRoot ||
    resolved === repositoryDirectory ||
    resolved === path.dirname(canonicalDirectory) ||
    resolved === canonicalDirectory
  ) {
    throw new Error(`Refusing unsafe zoom-review output path: ${resolved}`);
  }

  const entries = await readdir(resolved).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (entries?.length) {
    const sentinel = await readFile(path.join(resolved, outputSentinel), "utf8").catch(
      () => null
    );
    if (sentinel !== "SkyBao source-PNG zoom review\n") {
      throw new Error(
        `Refusing to replace non-zoom-review directory: ${resolved}`
      );
    }
  }

  await rm(resolved, { recursive: true, force: true });
  await mkdir(resolved, { recursive: true });
  await writeFile(
    path.join(resolved, outputSentinel),
    "SkyBao source-PNG zoom review\n"
  );
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Preview did not become ready: ${url}`);
}

async function startPreview(options) {
  if (options.baseUrl) {
    await waitForServer(options.baseUrl);
    return { baseUrl: options.baseUrl, server: null };
  }
  if (options.build)
    await run("yarn", ["build"], frontendDirectory, { ...process.env, VITE_SKYBAO_CAPTURE: "1", VITE_API_BASE: "/api" });
  const dist = path.join(frontendDirectory, "dist");
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json" };
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname.startsWith("/api/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(requestUrl.pathname === "/api/setup-complete" ? JSON.stringify({ results: { MultiUserMode: false, RequiresAuth: false } }) : "{}");
        return;
      }
      const requestPath = decodeURIComponent(requestUrl.pathname);
      let file = path.resolve(dist, `.${requestPath}`);
      if (!file.startsWith(`${dist}${path.sep}`) || !(await readFile(file).catch(() => null))) file = path.join(dist, "_index.html");
      const body = await readFile(file);
      response.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await waitForServer(baseUrl);
  return { baseUrl, server };
}

function captureUrl(baseUrl, asset) {
  const url = new URL(asset.route, baseUrl);
  url.searchParams.set("capture", "transparent");
  url.searchParams.set("artifact", "1");
  url.searchParams.set("framing", "workspace");
  url.searchParams.set("state", asset.state);
  return url.toString();
}

async function waitForCapture(page, asset) {
  try {
    await page.waitForFunction(() => window.__SKYBAO_CAPTURE__?.ready === true, { timeout: 20_000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({ url: location.href, title: document.title, body: document.body.innerText.slice(0, 240), capture: Boolean(window.__SKYBAO_CAPTURE__), root: document.documentElement.outerHTML.slice(0, 240) }));
    throw new Error(`Capture runtime did not become ready for ${asset.id}: ${JSON.stringify(debug)} errors=${JSON.stringify(page.__zoomReviewErrors || [])}; ${error.message}`);
  }
  await page.waitForSelector('[data-capture-id="app-shell"]', { visible: true, timeout: 20_000 });
  await page.waitForSelector(asset.area === "assistant" ? '[data-capture-id="assistant-root"]' : '[data-capture-id="native-area-root"]', { visible: true, timeout: 20_000 });
}

async function preparePage(page, baseUrl, asset) {
  await page.goto(captureUrl(baseUrl, asset), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForCapture(page, asset);
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
  try {
    await page.waitForSelector(selector, { visible: true, timeout: 10_000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, ids: [...document.querySelectorAll("[data-capture-id]")].map((element) => element.getAttribute("data-capture-id")).filter(Boolean), text: document.body.innerText.slice(0, 400) }));
    throw new Error(`Capture target ${target} was not visible: ${JSON.stringify(debug)}; ${error.message}`);
  }
  return page.$eval(selector, (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

async function targetPoint(page, target, xRatio, yRatio) {
  const selector = selectorFor(target);
  await page.waitForSelector(selector, { visible: true, timeout: 10_000 });
  return page.$eval(selector, (element, ratios) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width * ratios.x, y: rect.top + rect.height * ratios.y };
  }, { x: xRatio, y: yRatio });
}

function cursorEvent(frame, point, event, viewport) {
  return { frame, x: point.x, y: point.y, nx: point.x / viewport.width, ny: point.y / viewport.height, event };
}

async function executeFrameActions(page, asset, frame, runtime, cursor, viewport) {
  for (let index = 0; index < asset.actions.length; index += 1) {
    const action = asset.actions[index];
      const state = runtime.get(index) || {};
    if (action.type === "click" && action.frame === frame) {
      const point = await targetCenter(page, action.target);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.up();
      cursor.push(cursorEvent(frame, point, "click", viewport));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      // At narrow CSS viewports Chromium can deliver the pointer sequence to a
      // composited sibling while the visible button remains in place. Preserve
      // the real pointer attempt, then use the authored DOM action as a
      // deterministic recovery for this capture-only replay.
      if (action.target === "communications-draft-open" && !(await page.$(selectorFor("communications-draft-text")))) {
        await page.$eval(selectorFor(action.target), (element) => element.click());
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      runtime.set(index, { ...state, complete: true });
    }
    if (action.type === "select" && action.frame === frame) {
      const point = await targetCenter(page, action.target);
      cursor.push(cursorEvent(frame, point, "click", viewport));
      await page.select(selectorFor(action.target), action.value);
      runtime.set(index, { ...state, complete: true });
    }
    if (action.type === "type" && frame >= action.startFrame && frame <= action.endFrame) {
      if (!state.focused) {
        const point = await targetCenter(page, action.target);
        await page.$eval(selectorFor(action.target), (element) => {
          element.focus();
          if (typeof element.setSelectionRange === "function") {
            const end = element.value.length;
            element.setSelectionRange(end, end);
          }
        });
        cursor.push(cursorEvent(frame, point, "click", viewport));
        state.focused = true;
        state.typed = 0;
      }
      const progress = Math.min(1, (frame - action.startFrame) / Math.max(1, action.endFrame - action.startFrame));
      const desiredLength = Math.floor(progress * action.text.length);
      if (desiredLength > state.typed) {
        await page.keyboard.type(action.text.slice(state.typed, desiredLength));
        state.typed = desiredLength;
      }
      runtime.set(index, state);
    }
    if (action.type === "drag" && frame >= action.startFrame && frame <= action.endFrame) {
      if (!state.started) {
        // The card title deliberately stops pointer propagation for opening
        // the task. Use the lower card body for the drag pickup point so the
        // same real PointerSensor gesture works at every responsive zoom.
        state.start = await targetPoint(page, action.target, 0.82, 0.84);
        state.end = await targetCenter(page, action.destination);
        await page.mouse.move(state.start.x, state.start.y);
        await page.mouse.down();
        cursor.push(cursorEvent(frame, state.start, "down", viewport));
        state.started = true;
      }
      const progress = Math.min(1, (frame - action.startFrame) / Math.max(1, action.endFrame - action.startFrame));
      const point = { x: state.start.x + (state.end.x - state.start.x) * progress, y: state.start.y + (state.end.y - state.start.y) * progress };
      await page.mouse.move(point.x, point.y);
      cursor.push(cursorEvent(frame, point, "move", viewport));
      if (frame === action.endFrame) {
        await page.mouse.up();
        const moved = () => page.waitForFunction(
          (target, destination) => document.querySelector(destination)?.contains(document.querySelector(target)),
          { timeout: 1_000 },
          selectorFor(action.target),
          selectorFor(action.destination)
        );
        try {
          await moved();
        } catch {
          // dnd-kit can miss the final coalesced pointer move on a fractional
          // DPR viewport. Replay the same physical drag with intermediate
          // pointer steps; this remains a real PointerSensor interaction.
          await page.mouse.move(state.start.x, state.start.y);
          await page.mouse.down();
          await page.mouse.move(state.end.x, state.end.y, { steps: 16 });
          await page.mouse.up();
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          try {
            await page.waitForFunction(
              (target, destination) => document.querySelector(destination)?.contains(document.querySelector(target)),
              { timeout: 5_000 },
              selectorFor(action.target),
              selectorFor(action.destination)
            );
          } catch (error) {
            const debug = await page.evaluate((target, destination) => {
              const read = (selector) => {
                const element = document.querySelector(selector);
                if (!element) return null;
                const rect = element.getBoundingClientRect();
                return { rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, className: element.className, parent: element.parentElement?.getAttribute("data-capture-id") };
              };
              return { width: innerWidth, height: innerHeight, target: read(target), destination: read(destination), body: document.body.innerText.slice(0, 500) };
            }, selectorFor(action.target), selectorFor(action.destination));
            throw new Error(`Drag did not settle: ${JSON.stringify(debug)}; ${error.message}`);
          }
        }
        state.complete = true;
      }
      runtime.set(index, state);
    }
  }
}

async function replayToFrame(page, asset, frame, viewport) {
  const runtime = new Map();
  const cursor = [];
  for (let current = 0; current <= frame; current += 1) {
    await page.evaluate((nextFrame) => window.__SKYBAO_CAPTURE__.setFrame(nextFrame), current);
    await executeFrameActions(page, asset, current, runtime, cursor, viewport);
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return cursor;
}

function pngInfo(buffer, dimensions = physical, { rgbaOnly = true } = {}) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("PNG signature missing");
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      break;
    }
    offset += length + 12;
  }
  const validColorType = rgbaOnly ? colorType === 6 : colorType === 2 || colorType === 6;
  if (width !== dimensions.width || height !== dimensions.height || bitDepth !== 8 || !validColorType)
    throw new Error(`Expected ${dimensions.width}x${dimensions.height} 8-bit RGBA PNG, got ${width}x${height} depth=${bitDepth} type=${colorType}`);
  return { width, height, bitDepth, colorType };
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
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

function normalizeTransparentPng(buffer) {
  let offset = 8;
  let width;
  let height;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error("Zoom review screenshot must be 8-bit RGBA");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  const stride = width * 4;
  const inflated = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  let inputOffset = 0;
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const filter = inflated[inputOffset++];
    const raw = inflated.subarray(inputOffset, inputOffset + stride);
    inputOffset += stride;
    const row = Buffer.alloc(stride);
    const previous = rowIndex ? pixels.subarray((rowIndex - 1) * stride, rowIndex * stride) : null;
    const paeth = (a, b, c) => {
      const prediction = a + b - c;
      const pa = Math.abs(prediction - a);
      const pb = Math.abs(prediction - b);
      const pc = Math.abs(prediction - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    for (let index = 0; index < stride; index += 1) {
      const left = index >= 4 ? row[index - 4] : 0;
      const up = previous ? previous[index] : 0;
      const upperLeft = previous && index >= 4 ? previous[index - 4] : 0;
      row[index] = filter === 0 ? raw[index] : filter === 1 ? (raw[index] + left) & 255 : filter === 2 ? (raw[index] + up) & 255 : filter === 3 ? (raw[index] + Math.floor((left + up) / 2)) & 255 : filter === 4 ? (raw[index] + paeth(left, up, upperLeft)) & 255 : (() => { throw new Error(`Unsupported PNG filter ${filter}`); })();
    }
    row.copy(pixels, rowIndex * stride);
  }
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] === 0) pixels[index] = pixels[index + 1] = pixels[index + 2] = 0;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    pixels.copy(scanlines, rowIndex * (stride + 1) + 1, rowIndex * stride, (rowIndex + 1) * stride);
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function captureOne(page, baseUrl, asset, frame, zoom) {
  page.__zoomReviewErrors = [];
  page.on("pageerror", (error) => page.__zoomReviewErrors.push(error.message));
  page.on("requestfailed", (request) => page.__zoomReviewErrors.push(`request ${request.url()}: ${request.failure()?.errorText || "failed"}`));
  await page.setViewport({ width: zoom.width, height: zoom.height, deviceScaleFactor: zoom.dpr });
  await preparePage(page, baseUrl, asset);
  const cursor = await replayToFrame(page, asset, frame - 1, zoom);
  const png = normalizeTransparentPng(Buffer.from(await page.screenshot({ type: "png", omitBackground: true, captureBeyondViewport: false })));
  pngInfo(png);
  const runtime = await page.evaluate(() => ({ innerWidth, innerHeight, devicePixelRatio }));
  return { png, runtime, cursor };
}

function targetKey(target) {
  return `${target.assetId}-frame-${String(target.frame).padStart(3, "0")}`;
}

async function canonicalSnapshot(targetsToCapture) {
  const files = new Set([path.join(canonicalDirectory, "catalog.json"), path.join(canonicalDirectory, "checksums.sha256")]);
  for (const target of targetsToCapture) files.add(canonicalPath(target));
  const entries = [];
  for (const file of [...files].sort()) entries.push({ path: path.relative(repositoryDirectory, file).split(path.sep).join("/"), sha256: sha256(await readFile(file)) });
  return entries;
}

function canonicalPath(target) {
  const asset = MOTION_ASSETS.find((item) => item.id === target.assetId);
  if (!asset) throw new Error(`Unknown motion asset ${target.assetId}`);
  return path.join(canonicalDirectory, "clips", asset.area, asset.id, `frame-${String(target.frame).padStart(6, "0")}.png`);
}

async function contactSheet(browser, output, captures) {
  const page = await browser.newPage();
  await page.setViewport({ width: physical.width, height: physical.height, deviceScaleFactor: 1 });
  const cells = (await Promise.all(captures.map(async (capture) => `<figure><img src="data:image/png;base64,${(await readFile(capture.path)).toString("base64")}"><figcaption>${capture.asset.label}<br>${capture.zoom.percent}%</figcaption></figure>`))).join("");
  await page.setContent(`<!doctype html><style>*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;background:#07111c;color:#fff;font:22px system-ui,sans-serif}main{display:grid;grid-template-columns:repeat(5,384px);grid-template-rows:repeat(5,216px);width:1920px;height:1080px}figure{position:relative;margin:0;width:384px;height:216px;overflow:hidden;background:#102033}img{display:block;width:384px;height:216px;object-fit:contain}figcaption{position:absolute;left:8px;right:8px;top:8px;padding:5px 8px;border-radius:5px;background:rgba(0,0,0,.7);font-size:16px;line-height:1.2;text-shadow:0 1px 2px #000}</style><main>${cells}</main>`, { waitUntil: "load" });
  const sheetPath = path.join(output, "contact-sheet-5x5.png");
  await page.screenshot({ path: sheetPath, type: "png" });
  await page.close();
  pngInfo(await readFile(sheetPath), physical, { rgbaOnly: false });
  return sheetPath;
}

async function contactStrips(browser, output, captures) {
  const strips = [];
  for (const area of [...new Set(captures.map((capture) => capture.asset.area))]) {
    const page = await browser.newPage();
    await page.setViewport({ width: physical.width, height: 216, deviceScaleFactor: 1 });
    const areaCaptures = captures.filter((capture) => capture.asset.area === area);
    const cells = (await Promise.all(areaCaptures.map(async (capture) => `<figure><img src="data:image/png;base64,${(await readFile(capture.path)).toString("base64")}"><figcaption>${capture.zoom.percent}%</figcaption></figure>`))).join("");
    await page.setContent(`<!doctype html><style>*{box-sizing:border-box}html,body{margin:0;width:1920px;height:216px;background:#07111c;color:#fff;font:18px system-ui,sans-serif}main{display:grid;grid-template-columns:repeat(5,384px);width:1920px;height:216px}figure{position:relative;margin:0;width:384px;height:216px;overflow:hidden;background:#102033}img{display:block;width:384px;height:216px;object-fit:contain}figcaption{position:absolute;left:8px;top:8px;padding:4px 7px;border-radius:4px;background:rgba(0,0,0,.72);font-size:16px}</style><main>${cells}</main>`, { waitUntil: "load" });
    const stripPath = path.join(output, "strips", `${area}-5-wide.png`);
    await mkdir(path.dirname(stripPath), { recursive: true });
    await page.screenshot({ path: stripPath, type: "png" });
    await page.close();
    pngInfo(await readFile(stripPath), { width: physical.width, height: 216 }, { rgbaOnly: false });
    strips.push({ area, path: path.relative(output, stripPath).split(path.sep).join("/"), width: physical.width, height: 216, columns: 5, sha256: sha256(await readFile(stripPath)) });
  }
  return strips;
}

function printHelp() {
  console.log("SkyBao source-PNG zoom review");
  console.log("  yarn video:assets:zoom-review [--skip-build] [--base-url=<url>] [--out=<dir>]");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const assets = new Map(MOTION_ASSETS.map((asset) => [asset.id, asset]));
  for (const target of targets) if (!assets.has(target.assetId)) throw new Error(`Target asset missing: ${target.assetId}`);
  const beforeCanonical = await canonicalSnapshot(targets);
  await resetOutputDirectory(options.out);
  const preview = await startPreview(options);
  const browser = await puppeteer.launch({ headless: true, defaultViewport: null, args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--hide-scrollbars"] });
  const captures = [];
  try {
    for (const target of targets) {
      const asset = assets.get(target.assetId);
      const canonical = canonicalPath(target);
      const canonicalBytes = await readFile(canonical);
      pngInfo(canonicalBytes);
      const canonicalHash = sha256(canonicalBytes);
      for (const zoom of zoomLevels) {
        const key = targetKey(target);
        const relative = path.join("frames", key, `zoom-${zoom.percent}.png`);
        const outputPath = path.join(options.out, relative);
        let png;
        let runtime;
        let cursor = [];
        let captureMethod = "browser-zoom-viewport";
        if (zoom.percent === 100) {
          const page = await browser.newPage();
          const measured = await captureOne(page, preview.baseUrl, asset, target.frame, zoom);
          await page.close();
          png = canonicalBytes;
          runtime = measured.runtime;
          cursor = measured.cursor;
          captureMethod = "canonical-byte-copy";
        } else {
          const page = await browser.newPage();
          const result = await captureOne(page, preview.baseUrl, asset, target.frame, zoom);
          await page.close();
          ({ png, runtime, cursor } = result);
        }
        pngInfo(png);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, png);
        captures.push({ target, asset, zoom, path: outputPath, relative: relative.split(path.sep).join("/"), hash: sha256(png), canonicalHash, runtime, captureMethod, cursorEvents: cursor });
        console.log(`${zoom.percent}% ${asset.id} frame ${target.frame}`);
      }
    }
    const sheetPath = await contactSheet(browser, options.out, captures);
    const strips = await contactStrips(browser, options.out, captures);
    const afterCanonical = await canonicalSnapshot(targets);
    if (JSON.stringify(beforeCanonical) !== JSON.stringify(afterCanonical)) throw new Error("Canonical skybao-ui source hashes changed during zoom review");
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      physicalOutput: physical,
      zoomLevels,
      targets: targets.map((target) => ({ ...target, asset: assets.get(target.assetId).label, state: assets.get(target.assetId).state, route: assets.get(target.assetId).route })),
      canonicalIntegrity: { unchanged: true, before: beforeCanonical, after: afterCanonical },
      captures: captures.map(({ target, asset, zoom, relative, hash, canonicalHash, runtime, captureMethod, cursorEvents }) => ({
        path: relative,
        zoomPercent: zoom.percent,
        cssViewport: { width: zoom.width, height: zoom.height },
        requestedDevicePixelRatio: zoom.dpr,
        runtime: { ...runtime, captureMethod },
        outputDimensions: physical,
        source: { assetId: asset.id, area: asset.area, state: asset.state, route: asset.route, frame: target.frame },
        baselineCanonical: { path: path.relative(repositoryDirectory, canonicalPath(target)).split(path.sep).join("/"), sha256: canonicalHash },
        sha256: hash,
        cursorEvents,
      })),
      contactSheet: { path: path.relative(options.out, sheetPath).split(path.sep).join("/"), width: physical.width, height: physical.height, rows: 5, columns: 5, labels: "area/state/frame rows; zoom columns", sha256: sha256(await readFile(sheetPath)) },
      strips,
    };
    await writeFile(path.join(options.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${captures.length} PNGs and ${manifest.contactSheet.path}`);
  } finally {
    await browser.close();
    preview.server?.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
