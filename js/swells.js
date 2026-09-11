// Momentary swells.
//
// Hold a key and a parameter rises; let go and it sinks back to where it was.
// The point is gesture rather than automation — you are leaning on something,
// not programming it, and the moment you release, the piece returns to
// whatever state you had built.
//
// The base value is captured at the moment the key goes down, so a swell
// always returns to where you actually were rather than to a remembered
// default.

import { PARAMS } from './audio/granular.js';

const RISE = 0.9;      // seconds to reach full swell
const FALL = 2.2;      // seconds to sink back

export class Swells {
  constructor(engine, pads, norm, denorm) {
    this.engine = engine;
    this.pads = pads;
    this.norm = norm;
    this.denorm = denorm;
    this.active = new Map();       // macro index -> swell state
  }

  /**
   * @param {object} macro { param, amount, scope }
   * @param {number} selected the currently selected pad
   */
  press(index, macro, selected) {
    const spec = PARAMS[macro.param];
    if (!spec) return;
    const voices = macro.scope === 'all'
      ? this.engine.voices.filter((v, i) => this.pads[i].on)
      : [this.engine.voices[selected]];
    if (!voices.length) return;

    const existing = this.active.get(index);
    // Re-pressing mid-fall resumes from where it is, not from a jump.
    const t = existing ? existing.t : 0;

    this.active.set(index, {
      param: macro.param,
      spec,
      amount: macro.amount,
      t,
      held: true,
      targets: voices.map((v) => ({
        v,
        base: existing && existing.byVoice.get(v) !== undefined
          ? existing.byVoice.get(v)
          : this.norm(spec, v.p[macro.param]),
      })),
      byVoice: new Map(),
    });
  }

  release(index) {
    const s = this.active.get(index);
    if (s) s.held = false;
  }

  /** Called on the same timer as the morph, off the audio clock. */
  tick(dt) {
    for (const [index, s] of this.active) {
      s.t += (s.held ? dt / RISE : -dt / FALL);
      if (s.t >= 1) s.t = 1;
      if (s.t <= 0) {
        // Settle exactly back on the base, then stop touching it.
        for (const tg of s.targets) tg.v.set(s.param, this.denorm(s.spec, tg.base));
        this.active.delete(index);
        continue;
      }
      // Ease, so a swell leans in rather than ramping linearly.
      const k = s.t * s.t * (3 - 2 * s.t);
      for (const tg of s.targets) {
        const to = Math.max(0, Math.min(1, tg.base + s.amount));
        const now = tg.base + (to - tg.base) * k;
        s.byVoice.set(tg.v, tg.base);
        tg.v.set(s.param, this.denorm(s.spec, now));
      }
    }
    return this.active.size > 0;
  }

  get busy() { return this.active.size > 0; }
}
