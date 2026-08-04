#!/usr/bin/env node
// Deterministic ambient-tech film score + aligned SFX for the SkyBao reel.
// No dependencies, no network. Pure Node Buffer/TypedArray synthesis.
"use strict";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLE_RATE = 48000;
const DURATION = 40.0; // seconds
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const TOTAL_SAMPLES = Math.round(SAMPLE_RATE * DURATION); // 1,920,000
const BPM = 120;
const SPB = 60 / BPM; // seconds per beat = 0.5

// Deterministic PRNG (mulberry32) so output is stable across runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Best-effort read of shotlist.json (never fatal to synthesis).
function loadShotlist() {
  const p = path.join(__dirname, "shotlist.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Chord progression: D minor, Bb, F, C — low string + triad (midi).
const CHORDS = [
  { root: 38, tones: [50, 53, 57] }, // D2, D3, F3, A3
  { root: 34, tones: [46, 50, 53] }, // Bb1, Bb2, D3, F3
  { root: 29, tones: [41, 45, 48] }, // F1, A2, C3, F3
  { root: 36, tones: [48, 52, 55] }, // C2, C3, E3, G3
];
const CHORDS_PER_LOOP = CHORDS.length;
const BEATS_PER_CHORD = 8;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function synthMix() {
  const L = new Float64Array(TOTAL_SAMPLES);
  const R = new Float64Array(TOTAL_SAMPLES);

  const ns = (i, sl, sr) => {
    if (i < 0 || i >= TOTAL_SAMPLES) return;
    L[i] += sl;
    R[i] += sr;
  };

  const chordIndexAt = (t) => {
    const beat = t / SPB;
    const bar = Math.floor(beat / BEATS_PER_CHORD);
    return ((bar % CHORDS_PER_LOOP) + CHORDS_PER_LOOP) % CHORDS_PER_LOOP;
  };

  // ---------------- SMOOTH PAD ----------------
  // Slow-attack chord pad, one chord per 8 beats, sine + soft 2nd harmonic.
  {
    for (let i = 0; i < TOTAL_SAMPLES; i++) {
      const t = i / SAMPLE_RATE;
      const beat = t / SPB;
      const bar = Math.floor(beat / BEATS_PER_CHORD);
      const chordIndex = chordIndexAt(t);
      const tones = CHORDS[chordIndex].tones;
      const local = beat - bar * BEATS_PER_CHORD;
      const attack = clamp01(local / 1.5);
      const release = clamp01((BEATS_PER_CHORD - local) / 1.2);
      const amp = attack * release;
      let s = 0;
      for (const m of tones) {
        const f = midiToHz(m);
        s += Math.sin(2 * Math.PI * f * t) * 0.32;
        s += Math.sin(2 * Math.PI * f * 2 * t) * 0.08;
      }
      s *= 0.5 * (0.15 + 0.05 * chordIndex);
      const breathe =
        0.9 + 0.1 * Math.sin(2 * Math.PI * 0.125 * t + chordIndex);
      const width = 0.9 + 0.1 * Math.sin(2 * Math.PI * 0.11 * t);
      ns(i, s * amp * breathe, s * amp * breathe * width);
    }
  }

  // ---------------- SUB BASS PULSES ----------------
  // Root sine pulsing on each beat, soft plucked envelope.
  {
    for (let i = 0; i < TOTAL_SAMPLES; i++) {
      const t = i / SAMPLE_RATE;
      const beatFloat = t / SPB;
      const beat = Math.floor(beatFloat);
      const chordIndex = chordIndexAt(t);
      const rootM = CHORDS[chordIndex].root;
      const local = beatFloat - beat;
      const env = Math.exp(-local * 6.5) * (1 - local * 0.4);
      const f = midiToHz(rootM);
      const s =
        Math.sin(2 * Math.PI * f * t + 0.1 * Math.sin(2 * Math.PI * 3 * t)) *
        0.3 *
        env;
      ns(i, s, s);
    }
  }

  // ---------------- SUBTLE PLUCK ARP ----------------
  // Sparse plucks on chord tones an octave up, decaying bell-ish.
  {
    const addPluck = (t0, midi, gain) => {
      const s0 = Math.round(t0 * SAMPLE_RATE);
      if (s0 < 0 || s0 >= TOTAL_SAMPLES) return;
      const f = midiToHz(midi);
      const dur = Math.round(0.55 * SAMPLE_RATE);
      for (let i = 0; i < dur && s0 + i < TOTAL_SAMPLES; i++) {
        const tt = i / SAMPLE_RATE;
        const env = Math.exp(-tt * 11);
        const wob = 1 + 0.015 * Math.sin(2 * Math.PI * f * tt);
        const v =
          Math.sin(2 * Math.PI * f * tt * wob) * 0.16 * env * (gain ?? 1);
        ns(s0 + i, v * 0.9, v);
      }
    };
    for (let beat = 2; beat < 78; beat++) {
      const chordIndex =
        ((Math.floor(beat / BEATS_PER_CHORD) % CHORDS_PER_LOOP) +
          CHORDS_PER_LOOP) %
        CHORDS_PER_LOOP;
      const tones = CHORDS[chordIndex].tones;
      const bi = beat % BEATS_PER_CHORD;
      const pick = [0, 1, 2, 1, 0, 2, 1, 2][bi] ?? 0;
      addPluck(beat * SPB + 0.02, tones[pick] + 12, 1);
      if (bi === 3) addPluck(beat * SPB + 0.5, tones[pick], 0.6);
      if (bi === 7) addPluck(beat * SPB + 0.5, tones[(pick + 1) % 3] + 12, 0.5);
    }
  }

  // ---------------- LIGHT DETERMINISTIC PERCUSSION ----------------
  // Kick on every beat, soft hat on offbeats/quarters.
  {
    const rngKick = mulberry32(101);
    const rngHat = mulberry32(202);
    const addKick = (t0) => {
      const s0 = Math.round(t0 * SAMPLE_RATE);
      if (s0 < 0 || s0 >= TOTAL_SAMPLES) return;
      const dur = Math.round(0.24 * SAMPLE_RATE);
      for (let i = 0; i < dur && s0 + i < TOTAL_SAMPLES; i++) {
        const tt = i / SAMPLE_RATE;
        const f = 90 * Math.exp(-tt * 22) + 40;
        let phase = 0;
        const steps = 24;
        for (let k = 0; k < steps; k++)
          phase += 2 * Math.PI * (f + k * 0.0) * (1 / steps);
        const v = Math.sin(phase) * Math.exp(-tt * 9) * 0.32;
        ns(s0 + i, v, v);
      }
    };
    const addHat = (t0, accent) => {
      const s0 = Math.round(t0 * SAMPLE_RATE);
      if (s0 < 0 || s0 >= TOTAL_SAMPLES) return;
      const dur = Math.round(0.05 * SAMPLE_RATE);
      for (let i = 0; i < dur && s0 + i < TOTAL_SAMPLES; i++) {
        const tt = i / SAMPLE_RATE;
        const noise = rngHat() * 2 - 1;
        const v = noise * Math.exp(-tt * 130) * (accent ? 0.05 : 0.028);
        ns(s0 + i, v * 0.7, v);
      }
    };
    for (let beat = 1; beat < 79; beat++) {
      const t0 = beat * SPB;
      addKick(t0);
      addHat(t0 + SPB * 0.5, false);
      addHat(t0 + SPB * 0.25, beat % 2 === 0);
      addHat(t0 + SPB * 0.75, beat % 4 === 0);
    }
  }

  // ---------------- RISERS ----------------
  // Filtered noise swelling up into major structural beats.
  {
    const risers = [
      [26, 30],
      [50, 60],
      [79, 80],
    ]; // beat ranges
    for (const [c0, c1] of risers) {
      const s0 = Math.round(c0 * SPB * SAMPLE_RATE);
      const s1 = Math.round(c1 * SPB * SAMPLE_RATE);
      const rng = mulberry32(303 + c0);
      for (let i = s0; i < s1 && i < TOTAL_SAMPLES; i++) {
        const p = (i - s0) / (s1 - s0);
        const env = Math.pow(p, 2.2);
        const noise = rng() * 2 - 1;
        const v = noise * env * (0.35 + 0.35 * p);
        ns(i, v * 0.7, v);
      }
    }
  }

  return { L, R };
}

// ---------------- SFX aligned to shotlist cues ----------------
function addSfx(L, R, shotlist) {
  if (!shotlist || !Array.isArray(shotlist.shots)) return;
  const index = (frame) => Math.round((frame / 30) * SAMPLE_RATE);

  const click = (i0, gain) => {
    if (i0 < 0 || i0 >= TOTAL_SAMPLES) return;
    for (let i = 0; i < 900 && i0 + i < TOTAL_SAMPLES; i++) {
      const tt = i / SAMPLE_RATE;
      const v =
        Math.sin(2 * Math.PI * 2200 * tt) *
        Math.exp(-tt * 260) *
        (gain ?? 0.09);
      L[i0 + i] += v * 0.9;
      R[i0 + i] += v;
    }
  };
  const whoosh = (i0, gain) => {
    if (i0 < 0 || i0 >= TOTAL_SAMPLES) return;
    const rng = mulberry32(i0 % 100000);
    for (let i = 0; i < 9000 && i0 + i < TOTAL_SAMPLES; i++) {
      const tt = i / SAMPLE_RATE;
      const env = Math.sin(Math.PI * Math.min(1, tt / 0.3));
      const v = (rng() * 2 - 1) * env * (gain ?? 0.07);
      L[i0 + i] += v * 0.9;
      R[i0 + i] += v;
    }
  };
  const chime = (i0, gain) => {
    if (i0 < 0 || i0 >= TOTAL_SAMPLES) return;
    const fs = [880, 1318.51, 1760];
    for (let i = 0; i < 12000 && i0 + i < TOTAL_SAMPLES; i++) {
      const tt = i / SAMPLE_RATE;
      const env = Math.exp(-tt * 3.2);
      let v = 0;
      fs.forEach(
        (f, k) => (v += Math.sin(2 * Math.PI * f * tt) * (0.5 + 0.18 * k))
      );
      v *= env * (gain ?? 0.06);
      L[i0 + i] += v * 0.85;
      R[i0 + i] += v;
    }
  };

  for (const shot of shotlist.shots) {
    if (!Array.isArray(shot.sfxCues)) continue;
    for (const cue of shot.sfxCues) {
      const globalFrame = shot.frames.start - 1 + cue.frame;
      const i0 = index(globalFrame);
      if (cue.type === "click") click(i0, 0.09);
      else if (cue.type === "whoosh") whoosh(i0, 0.1);
      else if (cue.type === "chime") chime(i0, 0.07);
    }
  }
}

// ---------------- Master: width, fade, soft limit ----------------
function master({ L, R }) {
  const outL = new Float32Array(TOTAL_SAMPLES);
  const outR = new Float32Array(TOTAL_SAMPLES);
  for (let i = 0; i < TOTAL_SAMPLES; i++) {
    const mid = (L[i] + R[i]) * 0.5;
    let side = (L[i] - R[i]) * 0.5;
    side *= 1.45;
    outL[i] = mid + side;
    outR[i] = mid - side;
  }
  const fadeIn = Math.round(2.0 * SAMPLE_RATE);
  const fadeOut = Math.round(3.0 * SAMPLE_RATE);
  for (let i = 0; i < fadeIn && i < TOTAL_SAMPLES; i++) {
    const g = i / fadeIn;
    outL[i] *= g;
    outR[i] *= g;
  }
  for (let i = 0; i < fadeOut && i < TOTAL_SAMPLES; i++) {
    const j = TOTAL_SAMPLES - 1 - i;
    const g = i / fadeOut;
    outL[j] *= g;
    outR[j] *= g;
  }
  let peak = 1e-9;
  for (let i = 0; i < TOTAL_SAMPLES; i++) {
    peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
  }
  const norm = 0.93 / peak;
  const soft = (x) => Math.tanh(x * 1.4) / Math.tanh(1.4);
  for (let i = 0; i < TOTAL_SAMPLES; i++) {
    outL[i] = soft(outL[i] * norm) * 0.93;
    outR[i] = soft(outR[i] * norm) * 0.93;
  }
  return { outL, outR, peak: 0.93 };
}

// ---------------- WAV encode ----------------
function writeWav(outL, outR, file) {
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataSize = TOTAL_SAMPLES * CHANNELS * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * bytesPerSample, 28);
  buffer.writeUInt16LE(CHANNELS * bytesPerSample, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  let o = 44;
  const to16 = (v) => {
    const c = Math.max(-1, Math.min(1, v));
    return Math.round(c < 0 ? c * 0x8000 : c * 0x7fff);
  };
  for (let i = 0; i < TOTAL_SAMPLES; i++) {
    buffer.writeInt16LE(to16(outL[i]), o);
    o += 2;
    buffer.writeInt16LE(to16(outR[i]), o);
    o += 2;
  }
  fs.writeFileSync(file, buffer);
  return dataSize;
}

function main() {
  const args = process.argv.slice(2);
  let out = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "artifacts",
    "skybao-film",
    "audio",
    "skybao-mix.wav"
  );
  const outIdx = args.indexOf("--out");
  if (outIdx !== -1 && args[outIdx + 1]) out = path.resolve(args[outIdx + 1]);

  const shotlist = loadShotlist();
  const mix = synthMix();
  addSfx(mix.L, mix.R, shotlist);
  const { outL, outR, peak } = master(mix);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const dataSize = writeWav(outL, outR, out);
  const bytes = fs.statSync(out).size;

  console.log("SkyBao film mix · generated WAV");
  console.log(`  out:        ${out}`);
  console.log(`  duration:   ${(TOTAL_SAMPLES / SAMPLE_RATE).toFixed(3)}s`);
  console.log(`  channels:   ${CHANNELS}`);
  console.log(`  sampleRate: ${SAMPLE_RATE}`);
  console.log(`  bitDepth:   ${BITS_PER_SAMPLE}`);
  console.log(`  data:       ${dataSize} bytes`);
  console.log(
    `  fileSize:   ${bytes} bytes (${(bytes / 1048576).toFixed(2)} MiB)`
  );
  console.log(`  peak:       ${peak.toFixed(3)} (soft-limited, no clip)`);
  console.log(`  sfxShots:   ${shotlist ? shotlist.shotCount : "n/a"}`);
  console.log("done.");
}

main();
