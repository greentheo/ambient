// "Valley" — the first world. A town under a monolith, in the snow.
//
// A scene owns everything about how a place looks and behaves. The host
// (viz.js) only supplies the clock and the state of the music; what any of it
// means is up to the scene. Adding a world for a new set means adding a file
// here, not editing the host.

import { mulberry32 } from '../rng.js';
import { World } from '../world.js';
import { Population } from '../agents.js';
import { drawSky, drawStars, drawSun, Weather } from '../sky.js';

// Canvas blur is not universal; without it the near bank still reads, just sharper.
const CAN_BLUR = (() => {
  const c = document.createElement('canvas').getContext('2d');
  c.filter = 'blur(2px)';
  return c.filter !== 'none' && c.filter !== '';
})();

class Valley {
  constructor(seed, cfg) {
    this.seed = seed;
    this.cfg = cfg;
    this.rand = mulberry32(seed ^ 0x9e37);
    this.world = new World(seed, cfg);
    this.weather = new Weather(this.rand);
    this.people = new Population(this.rand, this.world);
  }

  /** Rebuild the parts that are baked at generation time. */
  rebuild(seed, cfg) {
    this.seed = seed;
    this.cfg = cfg;
    this.rand = mulberry32(seed ^ 0x9e37);
    this.world = new World(seed, cfg);
    this.people = new Population(this.rand, this.world);
  }

  /**
   * @param {object} s   smoothed instrument state
   * @param {object} env { seconds, sunHeight, night, warmth, angle }
   */
  update(dt, s, env) {
    const live = s.voices.filter((v) => v.on);
    const active = live.length;
    const mood = Math.min(1, s.master * 2.2) * this.cfg.pace;
    this.people.update(dt, Math.round(this.cfg.crowdBase + active * this.cfg.crowdPerVoice), mood);

    const density = live.length
      ? live.reduce((a, v) => a + v.density, 0) / live.length : 0;
    this.weather.update(dt, Math.min(1, (density / 34) * this.cfg.snow),
      (s.space.feedback * 2 - 0.6) * this.cfg.wind);
  }

  draw(ctx, w, h, s, env) {
    const { seconds, sunHeight, night, warmth, sunX } = env;
    const world = this.world;

    drawSky(ctx, w, h, sunHeight, warmth);
    drawStars(ctx, world, w, h, sunHeight, seconds);
    drawSun(ctx, w, h, sunX, sunHeight, warmth);

    const hazeAmt = Math.min(0.75, (0.10 + (s.space.reverb / 15) * 0.34) * this.cfg.haze);
    const tint = `${Math.round(120 + warmth * 40)},${Math.round(134 + warmth * 10)},${Math.round(150 - warmth * 20)}`;
    world.ridges.forEach((r, i) => {
      const shade = 10 + i * 3;
      ctx.fillStyle = `rgb(${shade},${shade + 3},${shade + 9})`;
      world.ridgePath(ctx, r, w, h, seconds * 0.004);
      ctx.fill();
      if (i < 3) this.haze(ctx, w, h, r.base * h, hazeAmt * (1 - i * 0.26), tint);
    });

    this.drawBlocks(ctx, w, h, night, warmth, s);
    this.drawTower(ctx, w, h, s, night, warmth);
    this.drawPlaza(ctx, w, h, night, warmth, s);

    this.people.draw(ctx, w, h, (u) => world.plazaY(u), warmth, night);
    this.drawPosts(ctx, w, h, night, warmth, s);
    this.drawForeground(ctx, w, h, night, warmth);
    this.weather.draw(ctx, w, h);
  }

  /** Haze between ridges — the reverb tail, made visible. */
  haze(ctx, w, h, y, amount, tint) {
    const g = ctx.createLinearGradient(0, y - h * 0.16, 0, y + h * 0.04);
    g.addColorStop(0, `rgba(${tint},0)`);
    g.addColorStop(1, `rgba(${tint},${amount})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, y - h * 0.16, w, h * 0.2);
  }

  drawTower(ctx, w, h, s, night, warmth) {
    const world = this.world;
    const t = world.tower;
    const baseY = world.groundY(t.x) * h;
    const topY = baseY - t.height * h;
    const halfW = t.width * w * 0.5;

    ctx.fillStyle = '#04060b';
    let y = baseY;
    let inset = 0;
    for (const slab of t.slabs) {
      const nextY = y - (baseY - topY) / t.slabs.length + slab.gap * h;
      const lean = t.lean * (baseY - y) * 4;
      ctx.fillRect(t.x * w - halfW * (1 - inset) + lean, nextY,
        halfW * 2 * (1 - inset), y - nextY);
      inset += slab.inset * 0.5;
      y = nextY;
    }
    if (t.spire) {
      ctx.beginPath();
      ctx.moveTo(t.x * w, topY - h * 0.09);
      ctx.lineTo(t.x * w - halfW * 0.14, topY);
      ctx.lineTo(t.x * w + halfW * 0.14, topY);
      ctx.closePath();
      ctx.fill();
    }

    const litness = Math.min(1, 0.25 + s.master * 1.6) * night;
    for (const win of world.windows) {
      const wx = t.x * w + (win.u - 0.5) * halfW * 1.7;
      const wy = baseY - win.v * (baseY - topY) * 0.94;
      const flick = 0.55 + 0.45 * Math.sin(performance.now() * 0.001 * win.rate + win.phase);
      ctx.globalAlpha = litness * flick * 0.8;
      ctx.fillStyle = `rgb(255,${188 + warmth * 50},${116 + warmth * 60})`;
      ctx.fillRect(wx, wy, 1.6, 2.4);
    }
    ctx.globalAlpha = 1;

    // The polyrhythm, made diegetic. Eight beacons climbing the tower, each
    // pulsing once per its pad's own cycle. They drift apart and will not
    // line up again for hours — which is precisely what the music is doing.
    s.voices.forEach((v, i) => {
      if (!v.on) return;
      const by = baseY - ((i + 0.6) / 8.6) * (baseY - topY);
      const bx = t.x * w + (i % 2 ? halfW : -halfW) * 0.92;
      const pulse = Math.pow(1 - v.position, 6);
      const r = h * (0.0022 + pulse * 0.006) * this.cfg.beacons;
      const hue = v.band ? '150,225,255' : '255,196,150';
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, r * 5);
      g.addColorStop(0, `rgba(${hue},${0.12 + pulse * 0.42})`);
      g.addColorStop(1, `rgba(${hue},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(bx - r * 5, by - r * 5, r * 10, r * 10);
      ctx.fillStyle = `rgba(255,248,236,${0.30 + pulse * 0.7})`;
      ctx.beginPath();
      ctx.arc(bx, by, 1.1 + pulse * 1.2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  drawBlocks(ctx, w, h, night, warmth, s) {
    ctx.fillStyle = '#05070d';
    for (const b of this.world.blocks) {
      const y = this.world.groundY(b.x) * h;
      ctx.fillRect(b.x * w - b.w * w * 0.5, y - b.h * h, b.w * w, b.h * h);
      if (b.lit > 0.45 && night > 0.2) {
        ctx.globalAlpha = night * (0.2 + s.master) * 0.7;
        ctx.fillStyle = `rgb(255,${180 + warmth * 50},110)`;
        ctx.fillRect(b.x * w - b.w * w * 0.2, y - b.h * h * 0.7, 1.5, 2);
        ctx.fillStyle = '#05070d';
        ctx.globalAlpha = 1;
      }
    }
  }

  /** The near ground. Snow catches whatever light is in the sky. */
  drawPlaza(ctx, w, h, night, warmth, s) {
    const top = this.world.plazaY(0) * h - h * 0.06;
    const lift = 1 - night;
    const g = ctx.createLinearGradient(0, top, 0, h);
    const base = 26 + lift * 46 + s.master * 26;
    g.addColorStop(0, `rgba(${base + warmth * 16},${base + 4},${base + 20},1)`);
    g.addColorStop(1, `rgba(${base * 0.35},${base * 0.36},${base * 0.5},1)`);

    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 3) ctx.lineTo(x, this.world.plazaY(x / w) * h);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
  }

  drawPosts(ctx, w, h, night, warmth, s) {
    for (const p of this.world.posts) {
      const x = p.u * w;
      const y = this.world.plazaY(p.u) * h;
      const top = y - p.h * h;
      ctx.fillStyle = '#04060b';
      ctx.fillRect(x - 1.2, top, 2.4, p.h * h);
      if (!p.lamp) continue;
      const glow = 0.25 + s.master * 0.9;
      const g = ctx.createRadialGradient(x, top, 0, x, top, h * 0.09);
      g.addColorStop(0, `rgba(255,${196 + warmth * 40},${140 + warmth * 40},${0.30 * night * glow})`);
      g.addColorStop(1, 'rgba(255,190,140,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - h * 0.09, top - h * 0.09, h * 0.18, h * 0.18);
      ctx.fillStyle = `rgba(255,228,186,${0.5 + night * 0.45})`;
      ctx.beginPath();
      ctx.arc(x, top, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * The near bank, drawn over everything and thrown out of focus. Depth of
   * field is what sells this as a miniature being observed rather than a flat
   * backdrop — the eye reads the soft edge as "close".
   */
  drawForeground(ctx, w, h, night, warmth) {
    const world = this.world;
    if (CAN_BLUR && this.cfg.bankBlur > 0.2) ctx.filter = `blur(${this.cfg.bankBlur}px)`;

    ctx.beginPath();
    ctx.moveTo(-40, h + 40);
    for (let x = -40; x <= w + 40; x += 4) ctx.lineTo(x, world.foreY(x / w) * h);
    ctx.lineTo(w + 40, h + 40);
    ctx.closePath();
    ctx.fillStyle = '#02040a';
    ctx.fill();

    for (const st of world.stalks) {
      const x = st.u * w;
      const y = world.foreY(st.u) * h;
      const top = y - st.h * h;
      ctx.beginPath();
      if (st.kind > 0.82) {
        ctx.moveTo(x, y);
        ctx.lineTo(x + st.lean * h * 0.01, top);
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = '#02040a';
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + st.lean * h * 0.01 - h * 0.008, top + h * 0.012);
        ctx.lineTo(x + st.lean * h * 0.01 + h * 0.008, top + h * 0.012);
        ctx.stroke();
      } else {
        ctx.moveTo(x - 1.6, y);
        ctx.quadraticCurveTo(x + st.lean * h * 0.03, (y + top) / 2, x + st.lean * h * 0.05, top);
        ctx.lineTo(x + st.lean * h * 0.05 + 1.4, top);
        ctx.quadraticCurveTo(x + st.lean * h * 0.03 + 1.6, (y + top) / 2, x + 1.6, y);
        ctx.closePath();
        ctx.fillStyle = '#02040a';
        ctx.fill();
      }
    }

    if (CAN_BLUR) ctx.filter = 'none';

    ctx.beginPath();
    for (let x = -40; x <= w + 40; x += 4) {
      const y = world.foreY(x / w) * h;
      if (x === -40) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(${138 + warmth * 40},${152},${180},${0.05 + (1 - night) * 0.07})`;
    ctx.lineWidth = Math.max(2, h * 0.006);
    ctx.stroke();
  }

  /** What the host shows in the corner. */
  status() {
    return `${this.people.agents.length} citizens`;
  }
}

// What can be tuned, and within what range. The editor is generated from
// this, so adding a knob here is all it takes to get a slider for it.
const params = [
  { k: 'ridges', label: 'Ridges', min: 2, max: 6, step: 1, def: 4, group: 'Landscape', rebuild: true },
  { k: 'ridgeHeight', label: 'Ridge height', min: 0.08, max: 0.55, step: 0.01, def: 0.30, group: 'Landscape', rebuild: true },
  { k: 'horizon', label: 'Horizon', min: 0.30, max: 0.70, step: 0.01, def: 0.50, group: 'Landscape', rebuild: true },
  { k: 'haze', label: 'Haze', min: 0, max: 2.5, step: 0.05, def: 1, group: 'Landscape' },
  { k: 'stars', label: 'Stars', min: 0, max: 700, step: 10, def: 260, group: 'Landscape', rebuild: true },

  { k: 'towerHeight', label: 'Tower height', min: 0.1, max: 0.8, step: 0.01, def: 0.44, group: 'City', rebuild: true },
  { k: 'towerWidth', label: 'Tower width', min: 0.02, max: 0.25, step: 0.005, def: 0.08, group: 'City', rebuild: true },
  { k: 'towerSlabs', label: 'Tower slabs', min: 2, max: 14, step: 1, def: 6, group: 'City', rebuild: true },
  { k: 'blocks', label: 'Blocks', min: 0, max: 60, step: 1, def: 20, group: 'City', rebuild: true },
  { k: 'blockHeight', label: 'Block height', min: 0.2, max: 3, step: 0.05, def: 1, group: 'City', rebuild: true },
  { k: 'windows', label: 'Windows', min: 0, max: 300, step: 5, def: 90, group: 'City', rebuild: true },
  { k: 'beacons', label: 'Beacon size', min: 0, max: 4, step: 0.05, def: 1, group: 'City' },

  { k: 'plaza', label: 'Plaza height', min: 0.70, max: 0.95, step: 0.005, def: 0.845, group: 'Foreground', rebuild: true },
  { k: 'posts', label: 'Lamp posts', min: 0, max: 20, step: 1, def: 7, group: 'Foreground', rebuild: true },
  { k: 'bankAmp', label: 'Bank roughness', min: 0, max: 0.25, step: 0.005, def: 0.085, group: 'Foreground', rebuild: true },
  { k: 'bankEdge', label: 'Bank framing', min: 0, max: 0.35, step: 0.005, def: 0.11, group: 'Foreground', rebuild: true },
  { k: 'stalks', label: 'Stalks', min: 0, max: 90, step: 1, def: 30, group: 'Foreground', rebuild: true },
  { k: 'bankBlur', label: 'Bank blur', min: 0, max: 30, step: 0.5, def: 9, group: 'Foreground' },

  { k: 'crowdBase', label: 'Crowd floor', min: 0, max: 20, step: 1, def: 2, group: 'Life' },
  { k: 'crowdPerVoice', label: 'Crowd per voice', min: 0, max: 8, step: 0.5, def: 2, group: 'Life' },
  { k: 'pace', label: 'Pace', min: 0.01, max: 3, step: 0.01, def: 1, group: 'Life' },
  { k: 'snow', label: 'Snow', min: 0, max: 3, step: 0.05, def: 1, group: 'Life' },
  { k: 'wind', label: 'Wind', min: -3, max: 3, step: 0.05, def: 1, group: 'Life' },
];

export default {
  id: 'valley',
  name: 'Valley',
  arc: 'transit',
  params,
  create: (seed, cfg) => new Valley(seed, cfg),
};
