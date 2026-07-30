# SkyBao Desktop

Runs SkyBao in its **own desktop window** instead of the system browser. This is a thin Electron wrapper — it does not change how the app works. The underlying server runs as an ordinary child process (using your system Node), and the window simply points at it.

This keeps the server's native modules (`@lancedb/lancedb`, `onnxruntime-node`, `canvas`, `sharp`, ...) working exactly as under `yarn prod:server`, with no Electron-ABI rebuilds.

## One-time setup

From the repo root:

```bash
yarn setup          # install server/collector/frontend deps + prisma (if not already done)
yarn desktop:setup  # install Electron into desktop/
yarn desktop:build  # build the SPA (same-origin /api) and stage it into server/public
```

## Run

```bash
yarn desktop
```

A SkyBao window opens. Server and collector logs stream to the terminal you launched from.

Day-to-day, just run `yarn desktop` again. Re-run `yarn desktop:build` only when you change the **frontend**; restart `yarn desktop` when you change the **backend**.

## Where things live

- **App data** (workspaces, documents, the SQLite DB): the repo's `server/storage/` — the same location `yarn prod:server` uses. Your existing data is reused.
- **Persisted secrets** (`JWT_SECRET`, `SIG_KEY`, `SIG_SALT`): stored under Electron's per-user userData dir (e.g. `~/Library/Application Support/SkyBao/secrets.json` on macOS). These stay stable across restarts so you don't get logged out. They are injected into the server process only; they are never written into the repo.
- **LLM / provider config**: create `server/.env` from `server/.env.example` and put your keys there. The server loads it in production mode and it supplements the injected secrets.

## How ports are chosen

The wrapper picks free ports starting at 3001 (server) and 8888 (collector), auto-incrementing if either is busy — so "port in use" no longer crashes startup.

## What this is not

- No installer/distribution build (`.dmg`/`.exe`/`.AppImage`). It runs from source.
- No bundled Node runtime. Uses the `node` on your PATH.
