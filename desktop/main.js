// Electron main process for the SkyBao desktop wrapper.
//
// Strategy: run the real anything-llm server (and the optional document
// collector) as ordinary child Node processes using the system `node`, then
// host a single BrowserWindow pointed at the server. This avoids having to
// rebuild the server's native modules (@lancedb/lancedb, onnxruntime-node,
// canvas, sharp, mdpdf, ...) against Electron's ABI — the server runs exactly
// as it does under `yarn prod:server`, just supervised by us.

const {
  app,
  BrowserWindow,
  shell,
  Menu,
  dialog,
  ipcMain,
} = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");
const crypto = require("crypto");

const APP_NAME = "SkyBao";

// Set the native application/menu name before Electron resolves app-scoped
// paths or creates any windows.
app.setName(APP_NAME);

// Resolve the repo root (parent of this desktop/ folder) regardless of where
// Electron was launched from.
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const COLLECTOR_DIR = path.join(REPO_ROOT, "collector");

// State -----------------------------------------------------------------------
let serverProc = null;
let collectorProc = null;
let mainWindow = null;
let isQuitting = false;
let resolvedServerPort = null;

// -----------------------------------------------------------------------------
// Port allocation
// -----------------------------------------------------------------------------

/**
 * Resolves to the first free port at or after `preferred`, so we don't crash
 * when something is already bound to the default 3001/8888.
 *
 * We require the port to be bindable on BOTH the IPv4 loopback (127.0.0.1)
 * and the IPv6/dual-stack wildcard (::), because:
 *   - the server is reached via http://127.0.0.1:<port> (IPv4), so IPv4 must
 *     be free or the window will hit a foreign server squatting there;
 *   - the anything-llm server binds the `::` wildcard, so IPv6 must be free
 *     too or it crashes with EADDRINUSE.
 * On macOS an IPv4-only socket and an `::` socket can coexist on the same
 * port, so checking only one stack would give a false "free".
 */
function findFreePort(preferred) {
  const tryBind = (host, port) =>
    new Promise((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(false));
      tester.once("listening", () => tester.close(() => resolve(true)));
      tester.listen(port, host);
    });

  return new Promise((resolve) => {
    const tryPort = async (port) => {
      const okV4 = await tryBind("127.0.0.1", port);
      if (!okV4) return tryPort(port + 1);
      const okV6 = await tryBind("::", port);
      if (!okV6) return tryPort(port + 1);
      resolve(port);
    };
    tryPort(preferred);
  });
}

// -----------------------------------------------------------------------------
// Secrets persistence (JWT_SECRET / SIG_KEY / SIG_SALT)
//
// These must be stable across launches, otherwise every restart logs everyone
// out and invalidates existing tokens. We persist them once under the
// per-user userData dir. They are only injected into the child process env —
// they are NOT written to the repo. Anything in server/.env still supplements
// them because dotenv does not clobber keys already on process.env.
// -----------------------------------------------------------------------------

function secretsPath() {
  return path.join(app.getPath("userData"), "secrets.json");
}

function randomSecret(len) {
  return crypto.randomBytes(len).toString("hex");
}

function loadOrCreateSecrets() {
  const file = secretsPath();
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        JWT_SECRET: parsed.JWT_SECRET || randomSecret(24),
        SIG_KEY: parsed.SIG_KEY || randomSecret(32),
        SIG_SALT: parsed.SIG_SALT || randomSecret(32),
      };
    }
  } catch (e) {
    console.warn("[desktop] Could not read secrets.json, regenerating:", e.message);
  }

  const fresh = {
    JWT_SECRET: randomSecret(24),
    SIG_KEY: randomSecret(32),
    SIG_SALT: randomSecret(32),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn("[desktop] Could not persist secrets.json:", e.message);
  }
  return fresh;
}

// -----------------------------------------------------------------------------
// Child process management
// -----------------------------------------------------------------------------

/**
 * The repo pins Node 18 (.nvmrc); several of the server's transitive deps
 * (e.g. buffer-equal-constant-time -> global SlowBuffer) break on Node 22+.
 * So we prefer a Node 18 binary when one exists, and otherwise fall back to
 * whatever `node` resolves to on PATH.
 *
 * Lookup order:
 *   1. Homebrew node@18 (the most common install on macOS dev machines).
 *   2. The exact node that launched this process (nvm/fnm/volta shims).
 *   3. The bare `node` on PATH.
 */
function resolveNodeBin() {
  const fs = require("fs");
  const candidates = [
    "/opt/homebrew/opt/node@18/bin/node", // Apple Silicon Homebrew
    "/usr/local/opt/node@18/bin/node", // Intel Homebrew
  ];
  if (process.execPath && /node(\.exe)?$/i.test(path.basename(process.execPath))) {
    candidates.push(process.execPath);
  }
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "node";
}

function buildServerEnv(secrets, ports) {
  // Start from a copy of this process's env so PATH, HOME, and any user-set
  // vars propagate. Then layer on anything-llm specifics.
  const env = { ...process.env };

  env.NODE_ENV = "production";
  env.SERVER_PORT = String(ports.server);
  env.COLLECTOR_PORT = String(ports.collector);

  // In production mode the server and collector read STORAGE_DIR directly
  // (it is NOT defaulted to server/storage the way it is in dev). Point it at
  // the repo's server/storage so the existing SQLite DB and documents are
  // reused. Only set it if the user hasn't already (e.g. via server/.env).
  if (!env.STORAGE_DIR) {
    env.STORAGE_DIR = path.join(SERVER_DIR, "storage");
  }

  // Secrets take precedence over anything in server/.env so they remain
  // stable. (dotenv won't overwrite keys already present on process.env.)
  env.JWT_SECRET = secrets.JWT_SECRET;
  env.SIG_KEY = secrets.SIG_KEY;
  env.SIG_SALT = secrets.SIG_SALT;

  return env;
}

function startServer(secrets, ports) {
  const nodeBin = resolveNodeBin();
  const env = buildServerEnv(secrets, ports);

  console.log(`[desktop] Starting server on port ${ports.server}...`);
  serverProc = spawn(nodeBin, ["index.js"], {
    cwd: SERVER_DIR,
    env,
    stdio: "inherit",
  });

  serverProc.on("error", (err) => {
    console.error("[desktop] Failed to spawn server:", err.message);
  });
  serverProc.on("exit", (code, signal) => {
    console.log(`[desktop] server exited (code=${code} signal=${signal})`);
    serverProc = null;
    if (!isQuitting) maybeRelaunch("server");
  });
}

function startCollector(ports) {
  const nodeBin = resolveNodeBin();
  const env = { ...process.env };
  env.NODE_ENV = "production";
  env.COLLECTOR_PORT = String(ports.collector);
  // Collector reads STORAGE_DIR directly in production mode (see
  // collector/utils/files/index.js). Keep it in sync with the server so
  // processed documents land in the same place.
  if (!env.STORAGE_DIR) {
    env.STORAGE_DIR = path.join(SERVER_DIR, "storage");
  }

  // The collector pulls in heavy native deps (puppeteer, sharp) and is only
  // needed for document ingestion / scraping. If it fails, we keep running —
  // the core chat experience does not depend on it.
  console.log(`[desktop] Starting collector on port ${ports.collector}...`);
  collectorProc = spawn(nodeBin, ["index.js"], {
    cwd: COLLECTOR_DIR,
    env,
    stdio: "inherit",
  });

  collectorProc.on("error", (err) => {
    console.warn("[desktop] Collector failed to start:", err.message);
    collectorProc = null;
  });
  collectorProc.on("exit", (code, signal) => {
    console.log(`[desktop] collector exited (code=${code} signal=${signal})`);
    collectorProc = null;
  });
}

/**
 * Guard against a transient crash loop spamming relaunches. Only relaunch once
 * per few seconds.
 */
let lastRelaunch = 0;
function maybeRelaunch(label) {
  if (isQuitting) return;
  const now = Date.now();
  if (now - lastRelaunch < 3000) {
    console.warn(`[desktop] ${label} crashed again too quickly, not relaunching.`);
    return;
  }
  lastRelaunch = now;
  console.log(`[desktop] Attempting to relaunch ${label}...`);
}

// -----------------------------------------------------------------------------
// Readiness check
// -----------------------------------------------------------------------------

/**
 * Single probe of /api/ping.
 * @returns {"ours" | "foreign" | "none"}
 *   - "ours":    responder is our anything-llm server (JSON {"online":true}).
 *   - "foreign": SOMETHING answered, but it is not our server (e.g. a foreign
 *                Vite dev server squatting on the IPv4 side via SO_REUSEPORT).
 *   - "none":    no responder yet (connection refused / timeout).
 */
function probePing(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = http.get(`http://127.0.0.1:${port}/api/ping`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        const ct = res.headers["content-type"] || "";
        const isOurs =
          res.statusCode === 200 &&
          ct.includes("application/json") &&
          body.includes('"online":true');
        done(isOurs ? "ours" : "foreign");
      });
    });
    req.on("error", () => done("none"));
    req.setTimeout(2000, () => req.destroy(new Error("ping timeout")));
    req.on("timeout", () => done("none"));
  });
}

/**
 * Polls until our server answers /api/ping correctly on 127.0.0.1. Bails fast
 * if a FOREIGN responder is detected (so we don't waste time on a port we'll
 * never own). Returns "ours" | "foreign" | "timeout".
 */
async function waitForServer(port, attempts = 45, delayMs = 1000) {
  let sawForeign = false;
  for (let i = 0; i < attempts; i++) {
    const r = await probePing(port);
    if (r === "ours") return "ours";
    if (r === "foreign") {
      sawForeign = true;
      // A foreign server answering means our IPv4 path is blocked — no point
      // waiting the full window. Give it 2 more chances in case ours is still
      // warming up, then bail.
      if (i >= 2) return "foreign";
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return sawForeign ? "foreign" : "timeout";
}

// -----------------------------------------------------------------------------
// Window
// -----------------------------------------------------------------------------

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: "#1c1e21",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(url);

  // Open external links (http/https) in the system browser, keep app-internal
  // navigations in the window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) {
      shell.openExternal(target);
      return { action: "deny" };
    }
    return { action: "permit" };
  });

  mainWindow.webContents.on("will-navigate", (event, target) => {
    // Allow only same-origin navigation (the SPA's client-side routing is all
    // same-origin under http://127.0.0.1:<port>).
    try {
      const parsed = new URL(target);
      const current = new URL(url);
      if (parsed.origin !== current.origin) {
        event.preventDefault();
        shell.openExternal(target);
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // A minimal menu — drop the default DevTools-forward menu.
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [isMac ? { role: "close" } : { role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? [
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
            ]
          : [{ role: "selectAll" }]),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -----------------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------------

async function bootstrap() {
  console.log(`[desktop] Booting ${APP_NAME} desktop wrapper...`);

  const secrets = loadOrCreateSecrets();

  // Pre-flight check: if a foreign server is ALREADY answering our ping on
  // 127.0.0.1 (e.g. another anything-llm instance), don't even try that port.
  // Then for each candidate port: spawn, wait for OUR server to answer
  // correctly, and if it can't (foreign server squatting the IPv4 side via
  // SO_REUSEPORT), kill it and advance. This is the only fully reliable way
  // to guarantee the window loads our app and not a neighbor's.
  let serverPort = 3001;
  let collectorPort = 8888;
  let started = false;

  for (let attempt = 0; attempt < 25 && !started; attempt++) {
    serverPort = await findFreePort(serverPort);
    collectorPort = await findFreePort(collectorPort);
    if (collectorPort === serverPort) {
      collectorPort = await findFreePort(serverPort + 1);
    }

    // Skip ports already serving a valid anything-llm ping (someone else's).
    if ((await probePing(serverPort)) === "ours") {
      console.log(
        `[desktop] Port ${serverPort} already serves the app; skipping.`
      );
      serverPort += 1; // advance so the next findFreePort tries the next port
      continue;
    }

    const ports = { server: serverPort, collector: collectorPort };
    startServer(secrets, ports);
    startCollector(ports);

    // Wait until our server answers correctly. If something else is answering
    // on the IPv4 side (foreign server via SO_REUSEPORT) we bail fast.
    const result = await waitForServer(serverPort, 45, 1000);
    if (result === "ours") {
      started = true;
      break;
    }

    // Not ours — tear down and try the next port.
    console.warn(
      `[desktop] Could not confirm our server on port ${serverPort} ` +
        `(${result}). Trying another port...`
    );
    await shutdown();
    serverPort += 1; // advance past the conflicted port
  }

  if (!started) {
    dialog.showMessageBoxSync({
      type: "error",
      title: APP_NAME,
      message: `Could not start the ${APP_NAME} server.`,
      detail:
        "Unable to find a free port the server could bind and answer on.\n\n" +
        "Check the terminal output for details. The app will close.",
      buttons: ["Quit"],
    });
    app.quit();
    return;
  }

  resolvedServerPort = serverPort;
  console.log(`[desktop] Server ready at http://127.0.0.1:${serverPort}`);
  createWindow(`http://127.0.0.1:${serverPort}`);
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    child.once("exit", finish);
    // Send SIGTERM first for graceful shutdown, escalate to SIGKILL.
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish();
    }, 4000);
  });
}

async function shutdown() {
  isQuitting = true;
  await Promise.all([killChild(serverProc), killChild(collectorProc)]);
}

// This app is a single window; closing it quits (matches most utility apps
// on Windows/Linux). On macOS we keep the conventional behavior.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async (event) => {
  if (!isQuitting) {
    event.preventDefault();
    await shutdown();
    app.exit(0);
  }
});

// If the Electron main is killed directly (SIGTERM/SIGINT/SIGHUP) — e.g. when
// the parent terminal is closed or a signal is sent by hand — `before-quit`
// may not fire, which would orphan the server and collector. Handle these
// signals explicitly and do the same cleanup, then re-raise to actually exit.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    if (isQuitting) return;
    shutdown().finally(() => {
      // Re-add the default behavior: exit with a non-zero code for signals.
      process.exit(128 + (sig === "SIGTERM" ? 15 : sig === "SIGINT" ? 2 : 1));
    });
  });
}

// Last-resort: if the process is about to exit for ANY reason, synchronously
// kill any still-living children by PID so they can't outlive us. This covers
// the SIGKILL case as best we can from within Node.
process.on("exit", () => {
  for (const child of [serverProc, collectorProc]) {
    if (child && child.exitCode === null && !child.signalCode) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
});

app.on("activate", () => {
  if (mainWindow === null && resolvedServerPort) {
    createWindow(`http://127.0.0.1:${resolvedServerPort}`);
  }
});

app.whenReady().then(bootstrap);
