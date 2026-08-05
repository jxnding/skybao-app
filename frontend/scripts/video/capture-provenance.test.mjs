import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createOutputStage,
  finalizeCatalogEntries,
  promoteOutputStage,
  recipeHash,
} from "./capture-skybao-assets.mjs";

test("capture recipes ignore nondeterministic Vite build bytes", () => {
  const asset = { id: "example", route: "/example" };
  const common = {
    generator: {
      recipeVersion: "skybao-capture-v4",
      node: "test",
      puppeteer: "25.4.0",
      platform: "darwin-arm64",
      fontConfig: null,
    },
    source: { frontendSourceSha256: "a".repeat(64) },
  };
  const first = recipeHash(asset, {
    ...common,
    source: { ...common.source, buildSha256: "b".repeat(64) },
  });
  const second = recipeHash(asset, {
    ...common,
    source: { ...common.source, buildSha256: "c".repeat(64) },
  });
  assert.equal(first, second);
});

test("targeted retakes preserve untouched owner provenance", async () => {
  const retained = {
    area: "knowledge",
    type: "clip",
    id: "owner-b",
    ownerId: "owner-b",
    framing: "workspace",
    directory: "clips/knowledge/owner-b",
    recipeVersion: "skybao-capture-v2",
    recipeSha256: "a".repeat(64),
    contentSha256: "b".repeat(64),
  };
  const fingerprint = {
    generator: { recipeVersion: "skybao-capture-v3" },
    source: { frontendSourceSha256: "c".repeat(64) },
  };

  const result = await finalizeCatalogEntries(
    "/unused",
    [retained],
    new Map([["owner-b", { id: "owner-b" }]]),
    fingerprint,
    new Set(["owner-a"])
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].recipeVersion, retained.recipeVersion);
  assert.equal(result[0].recipeSha256, retained.recipeSha256);
  assert.equal(result[0].contentSha256, retained.contentSha256);
});

test("capture output is unchanged until a validated stage is promoted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skybao-capture-test-"));
  const output = path.join(root, "skybao-ui");
  try {
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "marker.txt"), "approved\n");

    const stage = await createOutputStage(output, true);
    await writeFile(path.join(stage, "marker.txt"), "replacement\n");
    assert.equal(
      await readFile(path.join(output, "marker.txt"), "utf8"),
      "approved\n"
    );

    await promoteOutputStage(stage, output);
    assert.equal(
      await readFile(path.join(output, "marker.txt"), "utf8"),
      "replacement\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
