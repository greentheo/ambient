// Tap effects — gestures you hold rather than settings you leave.
//
// Every one of these applies while a pad is held and puts the voice back
// exactly as it was on release. The base values are captured at press, so an
// effect always returns to what you had built, not to a remembered default.
//
// They act on the selected pad, or on every live pad, per assignment.

import { PARAMS } from './audio/granular.js';

export const EFFECTS = {
  freeze: {
    label: 'Freeze',
    hint: 'Locks the read head. The cycle stops, grains keep firing from one spot.',
    press(v) { this.wasCycle = v.p.cycle; this.wasSync = v.syncBars; v.syncBars = 0; v.frozen = true; },
    release(v) { v.frozen = false; v.syncBars = this.wasSync; },
  },
  shatter: {
    label: 'Shatter',
    hint: 'Tiny grains, high density, wide spray — the source turns to dust.',
    params: { grain: 26, density: 48, spray: 0.85, detune: 4 },
  },
  throw: {
    label: 'Reverb throw',
    hint: 'Sends hard to the reverb; the wash trails after you let go.',
    params: { reverbSend: 1, delaySend: 0.75 },
  },
  reverse: {
    label: 'Reverse',
    hint: 'Flips the read head and plays grains backwards.',
    press(v) { v.dir *= -1; this.wasReverse = v.p.reverse; v.set('reverse', 1); },
    release(v) { v.dir *= -1; v.set('reverse', this.wasReverse); },
  },
  dive: {
    label: 'Pitch dive',
    hint: 'Drops an octave while held.',
    params: { pitch: -12 },
    absolute: true,
  },
  lift: {
    label: 'Pitch lift',
    hint: 'Up an octave while held.',
    params: { pitch: 12 },
    absolute: true,
  },
  muffle: {
    label: 'Muffle',
    hint: 'Slams the filter shut.',
    params: { cutoff: 180 },
  },
  swarm: {
    label: 'Swarm',
    hint: 'Long grains, dense and detuned — a thickening rather than a break-up.',
    params: { grain: 700, density: 34, detune: 7, spread: 1 },
  },
};

export class Effects {
  constructor(engine, pads) {
    this.engine = engine;
    this.pads = pads;
    this.held = new Map();       // slot -> { def, states }
  }

  targets(scope, selected) {
    return scope === 'all'
      ? this.engine.voices.filter((v, i) => this.pads[i].on)
      : [this.engine.voices[selected]];
  }

  press(slot, assign, selected) {
    if (this.held.has(slot)) return;
    const def = EFFECTS[assign.effect];
    if (!def) return;
    const voices = this.targets(assign.scope, selected);
    if (!voices.length) return;

    const states = voices.map((v) => {
      const st = { v, base: {}, ctx: {} };
      if (def.params) {
        for (const [k, target] of Object.entries(def.params)) {
          st.base[k] = v.p[k];
          // `absolute` values are an offset from where the parameter already
          // is; everything else is an outright destination.
          v.set(k, def.absolute ? v.p[k] + target : target);
        }
      }
      if (def.press) def.press.call(st.ctx, v);
      return st;
    });
    this.held.set(slot, { def, states });
  }

  release(slot) {
    const h = this.held.get(slot);
    if (!h) return;
    for (const st of h.states) {
      for (const [k, base] of Object.entries(st.base)) st.v.set(k, base);
      if (h.def.release) h.def.release.call(st.ctx, st.v);
    }
    this.held.delete(slot);
  }

  /** Release everything — used by the panic button. */
  clear() {
    for (const slot of [...this.held.keys()]) this.release(slot);
  }
}
