// Host for the worlds.
//
// This file owns only what every world needs: the link to the instrument, the
// day clock, the framing of the music into something a scene can read, and
// the readout in the corner. What a place looks like belongs in a scene
// module under scenes/, so a new set can have a new world without any of this
// changing.

import { Link } from './link.js';
import { ARCS, sunAt, azimuthAt, phaseName, nextCrossing } from './arc.js';
import * as config from './config.js';
import valley from './scenes/valley.js';

// Reports the world's clock back to the instrument, so a set can be played
// to the light rather than alongside it.
const backChannel = new BroadcastChannel('ambient-world');

const SCENES = [valley];

const params = new URLSearchParams(location.search);
const seed = (params.get('seed') | 0) || Math.floor(Math.random() * 1e9);
const dayLength = +(params.get('day') || 420);        // seconds per full cycle
const wanted = params.get('world') || SCENES[0].id;
const def = SCENES.find((s) => s.id === wanted) || SCENES[0];
// The scene proposes an arc; the URL can override it, so one place can be
// seen at sunset one night and never lit the next.
const arcName = params.get('arc') || def.arc || 'transit';
const arc = ARCS[arcName] || ARCS.transit;

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const link = new Link();

let cfg = config.load(def.id, def.params || []);
let scene = def.create(seed, cfg);

window.__viz = { link, scene, scenes: SCENES, seed, cfg };

document.getElementById('seed').textContent = seed;
document.getElementById('world').textContent = `${def.name.toLowerCase()} · ${arcName}`;
history.replaceState(null, '', `?world=${def.id}&arc=${arcName}&seed=${seed}&day=${dayLength}`);

let dayOffset = 0;
let lastMorph = 0;

function fit() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', fit);
fit();

function fmtTime(sec) {
  const m = Math.floor(sec / 60), r = Math.round(sec % 60);
  return m ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
}

/**
 * Where the light is. Depends only on elapsed time and the arc, so it can be
 * worked out without drawing anything — which is the whole point: the
 * instrument must keep getting the clock even when this tab is behind it.
 */
function clockNow() {
  const seconds = performance.now() / 1000;
  const u = (seconds + dayOffset) / dayLength;
  const sun = sunAt(arc, u);
  const rising = sunAt(arc, u + 0.004) > sun;
  return { seconds, u, sun, rising, phase: phaseName(sun, rising), next: nextCrossing(arc, u, dayLength) };
}

// Reported on a timer, never from the render loop. rAF stops the moment this
// tab goes behind the instrument, and the clock is exactly what must not.
setInterval(() => {
  const c = clockNow();
  backChannel.postMessage({
    world: def.id, arc: arcName, seed,
    phase: c.phase, sun: c.sun, rising: c.rising,
    next: c.next ? { to: c.next.to, seconds: c.next.seconds } : null,
    status: scene.status ? scene.status() : '',
  });
}, 250);

let last = performance.now();

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const seconds = now / 1000;
  const s = link.update(dt, seconds);

  // A scene morph nudges the clock forward, so changing scene changes the
  // hour — the light shifts with the music instead of alongside it.
  if (s.scene && s.scene.target !== null && s.scene.progress > lastMorph) {
    dayOffset += (s.scene.progress - lastMorph) * dayLength * 0.22;
  }
  lastMorph = s.scene && s.scene.target !== null ? s.scene.progress : 0;

  const w = innerWidth, h = innerHeight;
  // Position along the arc, not a plain sine — a night-only world never
  // brings the sun up no matter how long it runs.
  const c = clockNow();
  const { u, sun: sunHeight, rising } = c;
  // Where it sits across the sky, from the arc rather than from elevation.
  const sunX = azimuthAt(arc, u);
  const night = Math.max(0, Math.min(1, 0.5 - sunHeight * 1.6));

  // Average filter brightness across live voices becomes colour temperature,
  // so a dark mix literally looks colder.
  const live = s.voices.filter((v) => v.on);
  const bright = live.length
    ? live.reduce((a, v) => a + Math.log(v.cutoff / 80) / Math.log(225), 0) / live.length
    : 0.4;
  const warmth = Math.max(-0.5, Math.min(1, bright - 0.35));

  const { phase, next } = c;
  const env = { seconds, sunX, sunHeight, night, warmth, dayLength, arc: arcName, phase, rising, u };
  scene.update(dt, s, env);
  scene.draw(ctx, w, h, s, env);

  // Foreground vignette, to sit everything in the dark.
  const vig = ctx.createRadialGradient(w / 2, h * 0.55, h * 0.2, w / 2, h * 0.55, h * 0.95);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  document.getElementById('hud').classList.toggle('live', link.live);
  document.getElementById('state').textContent = link.live
    ? `${live.length} voices · ${Math.round(s.grains)} grains`
    : 'no instrument — demo';
  document.getElementById('clock').textContent =
    phase + (next ? ` · ${next.to} in ${fmtTime(next.seconds)}` : '');
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------------- editor ---------------- */

function reload(over = {}) {
  const q = { world: def.id, arc: arcName, seed, day: dayLength, ...over };
  location.search = `?world=${q.world}&arc=${q.arc}&seed=${q.seed}&day=${q.day}`;
}

function openEditor() {
  const panel = document.getElementById('panel');
  panel.classList.toggle('open');
  if (!panel.classList.contains('open') || panel.dataset.built) return;
  panel.dataset.built = '1';

  const foot = config.buildEditor({
    schema: def.params || [],
    cfg,
    meta: { world: def.id, arc: arcName, seed, day: dayLength },
    onChange: (key, needsRebuild) => {
      config.save(def.id, cfg);
      // Structural values are baked when the world is generated, so those
      // rebuild it in place. Everything else is read every frame already.
      if (needsRebuild && scene.rebuild) {
        scene.rebuild(seed, cfg);
        window.__viz.scene = scene;
      }
    },
    onMeta: (key, value) => reload({ [key]: value }),
  });

  foot.querySelector('#ed-save').addEventListener('click', () => {
    const blob = new Blob([config.toFile({ world: def.id, arc: arcName, seed, day: dayLength }, cfg)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `world-${def.id}-${seed}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  foot.querySelector('#ed-load').addEventListener('click', () => foot.querySelector('#ed-file').click());
  foot.querySelector('#ed-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const d = config.fromFile(await file.text());
      config.save(d.world || def.id, d.params);
      reload({ world: d.world || def.id, arc: d.arc || arcName, seed: d.seed ?? seed, day: d.day ?? dayLength });
    } catch (err) {
      alert(`Could not load: ${err.message}`);
    }
  });
  foot.querySelector('#ed-reset').addEventListener('click', () => {
    config.forget(def.id);
    reload();
  });
}

document.getElementById('btn-edit').addEventListener('click', openEditor);
document.getElementById('panel-close').addEventListener('click', () => {
  document.getElementById('panel').classList.remove('open');
});

addEventListener('keydown', (e) => {
  if (e.target.matches('input,select')) return;
  if (e.key === 'e') openEditor();
  if (e.key === 'f') document.documentElement.requestFullscreen?.();
  if (e.key === 'h') document.getElementById('hud').classList.toggle('gone');
  if (e.key === 'n') reload({ seed: Math.floor(Math.random() * 1e9) });
  if (e.key === 'w') {
    // Cycle worlds, keeping the seed — the same place, imagined differently.
    const next = SCENES[(SCENES.indexOf(def) + 1) % SCENES.length];
    reload({ world: next.id });
  }
  if (e.key === 'a') {
    // Cycle arcs, keeping the place. The same valley at a different hour.
    const names = Object.keys(ARCS);
    reload({ arc: names[(names.indexOf(arcName) + 1) % names.length] });
  }
});
