// Receives instrument state, and keeps the world moving when there is none.
//
// Values arrive at ~30Hz but are drawn at 60, so everything is eased towards
// its target rather than snapped — a beacon that jumped between frames would
// read as a glitch rather than as a pulse.

import { CHANNEL } from '../audio/broadcast.js';

const VOICES = 8;
const STALE_MS = 1500;

function blankVoice(i) {
  return {
    on: false, level: 0, position: (i * 0.37) % 1, cycle: [7.3, 11.1, 4.7, 13.9, 9.5, 17.3, 6.1, 23.7][i],
    cutoff: 2400, density: 12, grain: 180, notes: 0, band: false,
  };
}

export class Link {
  constructor() {
    this.raw = {
      t: 0, master: 0, grains: 0,
      scene: { active: null, target: null, progress: 0 },
      space: { reverb: 7, dark: 0.62, feedback: 0.55 },
      voices: Array.from({ length: VOICES }, (_, i) => blankVoice(i)),
    };
    this.smooth = JSON.parse(JSON.stringify(this.raw));
    this.lastSeen = 0;
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.onmessage = (e) => {
      this.raw = e.data;
      this.lastSeen = performance.now();
    };
  }

  get live() { return performance.now() - this.lastSeen < STALE_MS; }

  /**
   * With no instrument attached the world still has to breathe, so the demo
   * drives the cycles from the wall clock at the same rates the pads use.
   */
  demo(seconds) {
    const r = this.raw;
    r.master = 0.34 + 0.16 * Math.sin(seconds * 0.21);
    r.grains = 18;
    r.voices.forEach((v, i) => {
      v.on = i < 4;
      v.level = 0.55 + 0.25 * Math.sin(seconds * 0.13 + i);
      v.position = ((seconds / v.cycle) + i * 0.37) % 1;
      v.cutoff = 900 + 1800 * (0.5 + 0.5 * Math.sin(seconds * 0.05 + i * 1.7));
      v.density = 10 + 8 * (0.5 + 0.5 * Math.sin(seconds * 0.07 + i));
    });
  }

  /** @param {number} dt seconds since the last frame */
  update(dt, seconds) {
    if (!this.live) this.demo(seconds);
    const k = Math.min(1, dt * 6);            // easing rate
    const s = this.smooth, r = this.raw;
    s.master += (r.master - s.master) * k;
    s.grains += (r.grains - s.grains) * k;
    s.scene = r.scene;
    for (const key of ['reverb', 'dark', 'feedback']) {
      s.space[key] += (r.space[key] - s.space[key]) * k;
    }
    r.voices.forEach((rv, i) => {
      const sv = s.voices[i];
      sv.on = rv.on;
      sv.band = rv.band;
      sv.notes = rv.notes;
      sv.cycle = rv.cycle;
      // Position wraps, so ease along the shorter way round or it lurches
      // backwards through the whole cycle every time it passes zero.
      let d = rv.position - sv.position;
      if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
      sv.position = (sv.position + d * k + 1) % 1;
      for (const key of ['level', 'cutoff', 'density', 'grain']) {
        sv[key] += (rv[key] - sv[key]) * k;
      }
    });
    return s;
  }
}
