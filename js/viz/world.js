// The place. Generated once from a seed, then drawn every frame against
// whatever the music is doing.
//
// Everything here is silhouette work: layered ridges receding into haze, a
// structure that dominates the valley, and a plaza at the bottom of the frame
// where things small enough to have lives move around.

import { mulberry32, makeNoise, fbm } from './rng.js';

export class World {
  /** @param {object} cfg tunables from the scene's schema */
  constructor(seed, cfg = {}) {
    this.seed = seed;
    this.cfg = cfg;
    const rand = mulberry32(seed);
    this.rand = rand;
    const c = (k, d) => (cfg[k] === undefined ? d : cfg[k]);

    // Four ridges, furthest first. Each gets its own noise field so they do
    // not rhyme with each other.
    this.ridges = [];
    const ridgeCount = Math.round(c('ridges', 4));
    for (let i = 0; i < ridgeCount; i++) {
      this.ridges.push({
        noise: makeNoise(mulberry32(seed + i * 977)),
        scale: 1.1 + i * 0.9,
        height: c('ridgeHeight', 0.30) - i * 0.045,
        base: c('horizon', 0.50) + i * 0.075,
        parallax: 0.02 + i * 0.03,
        octaves: 5 - Math.min(2, i),
      });
    }

    // The monolith: a stack of slabs, wider at the base, with a spire.
    const slabs = Math.max(2, Math.round(c('towerSlabs', 6) + rand() * 2 - 1));
    this.tower = {
      x: 0.30 + rand() * 0.40,
      width: c('towerWidth', 0.08) * (0.7 + rand() * 0.6),
      height: c('towerHeight', 0.44) * (0.8 + rand() * 0.4),
      slabs: Array.from({ length: slabs }, (_, i) => ({
        inset: 0.06 + rand() * 0.22 * (i / slabs),
        gap: 0.012 + rand() * 0.02,
      })),
      spire: rand() > 0.35,
      lean: (rand() - 0.5) * 0.02,
    };

    // Outbuildings, so the tower is a city rather than a monument.
    this.blocks = Array.from({ length: Math.round(c('blocks', 20)) }, () => ({
      x: rand(),
      w: 0.012 + rand() * 0.035,
      h: (0.04 + rand() * 0.16) * c('blockHeight', 1),
      lit: rand(),
    }));

    // Window lights. Fixed positions, brightness driven by the music.
    this.windows = Array.from({ length: Math.round(c('windows', 90)) }, () => ({
      u: rand(), v: rand(), phase: rand() * Math.PI * 2, rate: 0.2 + rand() * 1.4,
    }));

    this.stars = Array.from({ length: Math.round(c('stars', 260)) }, () => ({
      x: rand(), y: rand() * 0.62, m: rand(), tw: rand() * Math.PI * 2,
    }));

    // The plaza is a separate, much nearer plane. Citizens live down here in
    // the foreground rather than up among the buildings, where at this scale
    // they would be specks.
    this.plaza = { noise: makeNoise(mulberry32(seed + 4441)), base: c('plaza', 0.845), amp: 0.020 };

    // Things to stand between: lamp posts and low walls along the plaza.
    this.posts = Array.from({ length: Math.round(c('posts', 7)) }, () => ({
      u: rand(), h: 0.055 + rand() * 0.045, lamp: rand() > 0.3,
    }));

    // The near bank. This sits between the viewer and the plaza and is what
    // turns a wide flat scene into something being looked at from a specific
    // place — you are down behind a drift, watching the town.
    this.fore = {
      noise: makeNoise(mulberry32(seed + 8123)),
      base: 0.985,
      amp: c('bankAmp', 0.085),
      scale: 2.3,
      // Higher at the edges than in the middle, so the bank frames the town
      // instead of just fencing it off. You are looking through a gap.
      edge: c('bankEdge', 0.11) * (0.8 + rand() * 0.4),
    };

    // A few things breaking the near edge: dead stalks, an antenna, a post.
    this.stalks = Array.from({ length: Math.round(c('stalks', 30)) }, () => ({
      // Biased towards the edges, where the bank is highest.
      u: (() => { const a = rand(); return rand() > 0.45 ? a : (a < 0.5 ? a * 0.34 : 1 - (1 - a) * 0.34); })(),
      h: 0.02 + rand() * 0.075,
      lean: (rand() - 0.5) * 0.5,
      kind: rand(),
    }));

    this.fbm = (noise, x, oct) => fbm(noise, x, oct);
  }

  /** Top edge of the near bank at u, in screen fraction. */
  foreY(u) {
    const f = this.fore;
    const edge = Math.pow(Math.abs(u - 0.5) * 2, 2.2) * f.edge;
    return f.base - this.fbm(f.noise, u * f.scale, 4) * f.amp - edge;
  }

  /** Foreground ground line, where the citizens walk. */
  plazaY(u) {
    const p = this.plaza;
    return p.base + (this.fbm(p.noise, u * 1.6, 3) - 0.5) * p.amp;
  }

  /** Ground height at horizontal position u (0..1), in screen fraction. */
  groundY(u) {
    // The nearest ridge, whichever that is — the count is configurable.
    const r = this.ridges[this.ridges.length - 1];
    return r.base - this.fbm(r.noise, u * r.scale, r.octaves) * r.height * 0.35;
  }

  ridgePath(ctx, r, w, h, drift) {
    const step = Math.max(2, Math.floor(w / 320));
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += step) {
      const u = x / w;
      const n = this.fbm(r.noise, u * r.scale + drift * r.parallax, r.octaves);
      ctx.lineTo(x, (r.base - n * r.height) * h);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
  }
}
