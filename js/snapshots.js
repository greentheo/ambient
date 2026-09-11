// Snapshots are how this thing gets structure without a timeline. Store the
// whole parameter state in a slot, then glide from where you are to that slot
// over half a minute. Nothing is sequenced — you are still playing it — but
// the piece moves.
//
// Snapshots hold parameters only, never audio. The sources on the pads are
// whatever you put there; a morph reshapes how they are being read.

import { PARAMS } from './audio/granular.js';
import { encodeWav, toBase64, fromBase64, sizeOf } from './audio/wav.js';

const SPACE_KEYS = ['rv-size', 'rv-decay', 'rv-dark', 'dl-time', 'dl-fb', 'dl-tone', 'master'];

export function captureState(engine, pads) {
  return {
    voices: engine.voices.map((v, i) => ({
      on: pads[i].on,
      dir: v.dir,
      filterType: v.filterType,
      syncBars: v.syncBars,
      p: { ...v.p },
    })),
    space: Object.fromEntries(
      SPACE_KEYS.map((k) => [k, +document.getElementById(k).value])
    ),
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }

/** Ease in and out, so a morph starts and lands gently. */
function smooth(t) { return t * t * (3 - 2 * t); }

export class Morpher {
  constructor(engine, pads, onApplySpace, onFrame) {
    this.engine = engine;
    // Timed off the audio clock, not the animation clock. A morph has to keep
    // gliding correctly even if the window is hidden or the machine stutters —
    // the sound carries on regardless, so the automation must too.
    this.ctx = engine.ctx;
    this.pads = pads;
    this.onApplySpace = onApplySpace;
    this.onFrame = onFrame;
    this.active = null;
  }

  get running() { return !!this.active; }

  /** @param {object} to target state @param {number} seconds glide time */
  start(to, seconds) {
    const from = captureState(this.engine, this.pads);

    // Voices coming in start silent and are raised by the morph itself;
    // voices going out are lowered first and only stopped at the end.
    to.voices.forEach((tv, i) => {
      const v = this.engine.voices[i];
      if (tv.on && !this.pads[i].on) {
        v.set('level', 0.0001);
        from.voices[i].p.level = 0.0001;
        this.pads[i].on = true;
        v.start();
      }
      if (!tv.on && this.pads[i].on) {
        to.voices[i] = { ...tv, p: { ...tv.p, level: 0.0001 } };
      }
    });

    this.active = { from, to, seconds, t0: this.ctx.currentTime };
  }

  cancel() { this.active = null; }

  /** Called once per animation frame. */
  tick() {
    if (!this.active) return;
    const { from, to, seconds, t0 } = this.active;
    const raw = Math.min(1, (this.ctx.currentTime - t0) / seconds);
    const t = smooth(raw);

    to.voices.forEach((tv, i) => {
      const v = this.engine.voices[i];
      const fv = from.voices[i];
      for (const key of Object.keys(PARAMS)) {
        // A state saved before a parameter existed has no value for it. Fall
        // back to what the voice is doing now rather than lerping to NaN.
        const from = Number.isFinite(fv.p[key]) ? fv.p[key] : v.p[key];
        const to = Number.isFinite(tv.p[key]) ? tv.p[key] : v.p[key];
        v.set(key, lerp(from, to, t));
      }
      if (raw >= 1) {
        v.dir = tv.dir;
        if (tv.filterType && tv.filterType !== v.filterType) v.setFilterType(tv.filterType);
        if (tv.syncBars !== undefined) v.syncBars = tv.syncBars;
      }
    });

    const space = {};
    for (const k of Object.keys(to.space)) {
      space[k] = lerp(from.space[k], to.space[k], t);
    }
    this.onApplySpace(space);

    if (raw >= 1) {
      // Land the reverb exactly on target now that the glide is over.
      space.settle = true;
      this.onApplySpace(space);
      // Anything that morphed down to silence is stopped for real now.
      to.voices.forEach((tv, i) => {
        if (!tv.on && this.pads[i].on) {
          this.pads[i].on = false;
          this.engine.voices[i].stop();
        }
      });
      this.active = null;
    }
    if (this.onFrame) this.onFrame(raw);
  }
}

/**
 * A forged source is fully described by its parameters and rebuilds exactly.
 * Everything else — captures, kept live windows, stretched buffers, dropped
 * files — has to carry its audio, or opening the session loses it.
 */
function needsAudio(pad) {
  if (!pad.buffer || pad.live) return false;
  return !pad.source || pad.source.kind !== 'forge';
}

/** @returns {{json: string, embedded: number, bytes: number}} */
export function serialize(slots, engine, pads, includeAudio = true) {
  const audio = {};
  let bytes = 0;
  if (includeAudio) {
    pads.forEach((p, i) => {
      if (!needsAudio(p)) return;
      const wav = encodeWav(p.buffer);
      bytes += wav.byteLength;
      audio[i] = toBase64(wav);
    });
  }
  const json = JSON.stringify({
    format: 'ambient-session',
    version: 2,
    slots,
    current: captureState(engine, pads),
    sources: pads.map((p) => ({ name: p.name, source: p.source || null })),
    audio,
  }, null, 2);
  return { json, embedded: Object.keys(audio).length, bytes };
}

/** Estimated size of the audio a save would embed, in bytes. */
export function audioSize(pads) {
  return pads.reduce((n, p) => n + (needsAudio(p) ? sizeOf(p.buffer) : 0), 0);
}

/** Decode any embedded audio back into AudioBuffers, keyed by pad index. */
export async function decodeAudio(ctx, data) {
  const out = {};
  for (const [i, b64] of Object.entries(data.audio || {})) {
    try {
      out[i] = await ctx.decodeAudioData(fromBase64(b64));
    } catch (err) {
      console.error('session audio', i, err);
    }
  }
  return out;
}

export function deserialize(text) {
  const data = JSON.parse(text);
  if (data.format !== 'ambient-session') throw new Error('not an Ambient session file');
  // Older sessions predate some parameters. Fill the gaps from the defaults so
  // nothing downstream ever sees a missing value.
  const fill = (state) => {
    if (!state || !state.voices) return state;
    for (const v of state.voices) {
      for (const [k, spec] of Object.entries(PARAMS)) {
        if (!Number.isFinite(v.p[k])) v.p[k] = spec.def;
      }
    }
    return state;
  };
  fill(data.current);
  (data.slots || []).forEach(fill);
  return data;
}
