// Sky, sun and weather. The day runs on its own long clock; the music decides
// how thick the air is and how cold the light looks.

/** Palette keyed to the sun's height, from deep night to overcast noon. */
function skyColours(sunHeight, warmth) {
  const night = [[6, 9, 16], [12, 17, 30], [20, 26, 42]];
  const dusk = [[18, 20, 38], [58, 44, 66], [122, 78, 82]];
  const day = [[38, 58, 84], [92, 116, 142], [158, 176, 190]];

  let a, b, t;
  if (sunHeight < 0) { a = night; b = dusk; t = Math.min(1, (sunHeight + 0.25) / 0.25); }
  else { a = dusk; b = day; t = Math.min(1, sunHeight / 0.45); }
  t = Math.max(0, t);

  return a.map((c, i) => {
    const mixed = c.map((v, k) => v + (b[i][k] - v) * t);
    // Warmth pulls the whole sky towards amber; cold pushes it blue. It is
    // driven by filter brightness, so a dark mix literally looks colder.
    mixed[0] += warmth * 26;
    mixed[1] += warmth * 8;
    mixed[2] -= warmth * 14;
    return mixed.map((v) => Math.max(0, Math.min(255, Math.round(v))));
  });
}

export function drawSky(ctx, w, h, sunHeight, warmth) {
  const [top, mid, low] = skyColours(sunHeight, warmth);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `rgb(${top})`);
  g.addColorStop(0.55, `rgb(${mid})`);
  g.addColorStop(1, `rgb(${low})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

export function drawStars(ctx, world, w, h, sunHeight, t) {
  const vis = Math.max(0, Math.min(1, -sunHeight * 3));
  if (vis <= 0.01) return;
  for (const s of world.stars) {
    const tw = 0.6 + 0.4 * Math.sin(t * 0.7 + s.tw);
    ctx.globalAlpha = vis * s.m * tw * 0.9;
    ctx.fillStyle = '#dfe8ff';
    ctx.fillRect(s.x * w, s.y * h, 1.4, 1.4);
  }
  ctx.globalAlpha = 1;
}

/** @param {number} xFrac horizontal position across the sky, 0..1 */
export function drawSun(ctx, w, h, xFrac, sunHeight, warmth) {
  const x = xFrac * w;
  const y = (0.62 - sunHeight * 0.78) * h;
  const moon = sunHeight < -0.02;
  const r = moon ? h * 0.018 : h * 0.030;

  const glow = ctx.createRadialGradient(x, y, 0, x, y, r * (moon ? 7 : 13));
  const core = moon ? '210,225,255' : `255,${190 + warmth * 40},${140 + warmth * 30}`;
  glow.addColorStop(0, `rgba(${core},${moon ? 0.30 : 0.42})`);
  glow.addColorStop(1, `rgba(${core},0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(x - r * 14, y - r * 14, r * 28, r * 28);

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = moon ? 'rgba(226,236,255,0.92)' : `rgba(255,${215 + warmth * 30},${170 + warmth * 40},0.95)`;
  ctx.fill();
  return { x, y };
}

export class Weather {
  constructor(rand) {
    this.flakes = Array.from({ length: 900 }, () => ({
      x: rand(), y: rand(), z: 0.25 + rand() * 0.75,
      drift: rand() * Math.PI * 2, spd: 0.4 + rand() * 0.8,
    }));
  }

  /**
   * @param {number} intensity 0..1, from grain density — busier music, thicker air
   * @param {number} wind      lateral drift, from the delay feedback
   */
  update(dt, intensity, wind) {
    const n = Math.floor(this.flakes.length * intensity);
    for (let i = 0; i < n; i++) {
      const f = this.flakes[i];
      f.y += dt * 0.035 * f.spd * f.z;
      f.drift += dt * 0.5;
      f.x += dt * (0.012 * wind + Math.sin(f.drift) * 0.004) * f.z;
      if (f.y > 1) { f.y -= 1; f.x = Math.random(); }
      if (f.x > 1) f.x -= 1; else if (f.x < 0) f.x += 1;
    }
    this.active = n;
  }

  draw(ctx, w, h) {
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < this.active; i++) {
      const f = this.flakes[i];
      ctx.globalAlpha = 0.10 + f.z * 0.32;
      const s = 0.7 + f.z * 1.7;
      ctx.fillRect(f.x * w, f.y * h, s, s);
    }
    ctx.globalAlpha = 1;
  }
}
