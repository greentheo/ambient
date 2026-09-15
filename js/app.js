import { Engine } from './audio/engine.js';
import { PARAMS } from './audio/granular.js';
import { SEEDS, ROOTS, generateSeed, decodeFile } from './audio/sources.js';
import { Recorder } from './audio/recorder.js';
import { InputCapture } from './audio/capture.js';
import { LiveBuffer } from './audio/livebuf.js';
import { paulStretch } from './audio/stretch.js';
import { Midi, KNOB_TARGETS, RELATIVE, noteOf } from './audio/midi.js';
import { Swells } from './swells.js';
import { Effects, EFFECTS } from './effects.js';
import { runTour, shouldRun } from './tour.js';
import { Broadcast, WorldClock } from './audio/broadcast.js';
import * as freesound from './audio/freesound.js';
import { captureState, Morpher, serialize, deserialize, decodeAudio, audioSize } from './snapshots.js';

const PAD_COUNT = 8;
// Deliberately unrelated defaults. Nothing here divides evenly into anything
// else, so the pads phase against each other indefinitely.
const DEFAULT_CYCLES = [7.3, 11.1, 4.7, 13.9, 9.5, 17.3, 6.1, 23.7];
const SLOT_NAMES = ['A', 'B', 'C', 'D'];
const COLS_STORE = 'ambient.params.cols';
const KNOBMODE_STORE = 'ambient.knob.mode';
const SIZE_STORE = 'ambient.ui.size';
const PALETTE_STORE = 'ambient.ui.palette';

// Canvas drawing cannot use CSS variables directly, so the palette is read
// once and cached. Invalidated whenever the palette changes.
let THEME = {};
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, d) => (cs.getPropertyValue(n) || d).trim();
  THEME = {
    wave: v('--wave', '#7fd1c1'),
    waveOff: v('--wave-off', '#46536a'),
    head: v('--head', '#e8c46a'),
    accent: v('--accent', '#7fd1c1'),
    accent2: v('--accent-2', '#9b8cf0'),
    dim: v('--dim', '#8492aa'),
    faint: v('--faint', '#5b6779'),
    line: v('--line', '#222c3d'),
    ink: v('--ink', '#dfe6f2'),
  };
}

function wirePalette() {
  const sel = $('palette');
  const saved = localStorage.getItem(PALETTE_STORE);
  if (saved) sel.value = saved;
  const apply = () => {
    document.documentElement.dataset.palette = sel.value;
    try { localStorage.setItem(PALETTE_STORE, sel.value); } catch {}
    readTheme();
  };
  sel.addEventListener('change', apply);
  apply();
}

// The first eight are the knob targets, in knob order, so cell 1 on screen is
// knob 1 under your hand. The rest follow.
const PARAM_ORDER = [
  ...KNOB_TARGETS,
  ...Object.keys(PARAMS).filter((k) => !KNOB_TARGETS.includes(k)),
];

// Tracker-style note row, so polyphony works without plugging anything in.
const QWERTY = { a:0, w:1, s:2, e:3, d:4, f:5, t:6, g:7, y:8, h:9, u:10, j:11, k:12 };

const engine = new Engine(PAD_COUNT);
let recorder = null;
let input = null;
let liveBuf = null;
let midi = null;
let morpher = null;
let broadcast = null;
let worldClock = null;
let swells = null;
let effects = null;

const pads = Array.from({ length: PAD_COUNT }, (_, i) => ({
  name: 'empty', buffer: null, peaks: null, on: false, index: i,
  source: null, original: null, live: false,
}));
let selected = 0;
const slots = [null, null, null, null];
let activeScene = null;     // the scene we last landed on
let morphTarget = null;     // the scene we are gliding towards
let morphProgress = 0;
let sceneEdited = false;
let fsResults = [];

// Held notes, and the soft-takeover state for absolute MIDI knobs.
const qwertyHeld = new Set();
const knobState = new Map();
let knobMode = 'pickup';

const $ = (id) => document.getElementById(id);

/* ---------------- param scaling ---------------- */

function norm(spec, v) {
  if (spec.curve === 'log') return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
  return (v - spec.min) / (spec.max - spec.min);
}
function denorm(spec, t) {
  t = Math.min(1, Math.max(0, t));
  if (spec.curve === 'log') return spec.min * Math.pow(spec.max / spec.min, t);
  return spec.min + t * (spec.max - spec.min);
}
function fmt(spec, v) {
  const dec = spec.step >= 1 ? 0 : spec.step >= 0.1 ? 1 : spec.step >= 0.01 ? 2 : 3;
  return v.toFixed(v >= 1000 ? 0 : dec);
}

/* ---------------- sources on pads ---------------- */

function computePeaks(buffer, bins = 480) {
  const d = buffer.getChannelData(0);
  const per = Math.max(1, Math.floor(d.length / bins));
  const out = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    let peak = 0;
    const start = b * per;
    const end = Math.min(d.length, start + per);
    for (let i = start; i < end; i++) {
      const m = Math.abs(d[i]);
      if (m > peak) peak = m;
    }
    out[b] = peak;
  }
  return out;
}

function assignBuffer(i, buffer, name, source = null) {
  const pad = pads[i];
  if (pad.live) detachLive();
  pad.buffer = buffer;
  pad.peaks = computePeaks(buffer);
  pad.name = name;
  pad.source = source;
  pad.original = null;
  engine.voices[i].setBuffer(buffer);
  if (pad.on) engine.voices[i].start();
  renderPadHeads();
  if (i === selected) refreshPadPanel();
}

/* ---------------- pad tiles ---------------- */

function buildPads() {
  const host = $('pads');
  host.innerHTML = '';
  pads.forEach((pad, i) => {
    const el = document.createElement('div');
    el.className = 'pad';
    el.dataset.i = i;
    el.innerHTML = `
      <div class="pad-head">
        <div class="pad-num">${i + 1}</div>
        <button class="pad-play" title="Fade this pad in or out"></button>
        <div class="pad-name"></div>
        <div class="pad-cyc"></div>
      </div>
      <canvas></canvas>`;
    host.appendChild(el);
    pad.el = el;
    pad.canvas = el.querySelector('canvas');
    // The pad is playable with a mouse alone; the number keys are a shortcut,
    // not the only way in.
    el.querySelector('.pad-play').addEventListener('click', (e) => {
      e.stopPropagation();
      select(i);
      togglePad(i);
    });
    wirePad(pad);
  });
  renderPadHeads();
}

function renderPadHeads() {
  pads.forEach((pad, i) => {
    pad.el.querySelector('.pad-name').textContent = pad.live ? `${pad.name} ●` : pad.name;
    const v = engine.voices[i];
    pad.el.querySelector('.pad-cyc').textContent = v.syncBars > 0
      ? `${v.syncBars % 1 ? v.syncBars : v.syncBars | 0} bar${v.syncBars === 1 ? '' : 's'}`
      : `${v.p.cycle.toFixed(1)}s`;
    pad.el.classList.toggle('on', pad.on);
    pad.el.classList.toggle('sel', i === selected);
    const play = pad.el.querySelector('.pad-play');
    play.textContent = pad.on ? '❚❚' : '▶';
    play.classList.toggle('playing', pad.on);
    play.classList.toggle('empty', !pad.buffer);
    play.disabled = !pad.buffer;
  });
}

function togglePad(i) {
  const pad = pads[i];
  if (!pad.buffer) { select(i); return; }
  pad.on = !pad.on;
  if (pad.on) engine.voices[i].start(); else engine.voices[i].stop();
  renderPadHeads();
}

function select(i) {
  if (i === selected) { renderPadHeads(); return; }
  // Held notes follow the selection rather than being stranded on the old voice.
  engine.voices[selected].setNotes([]);
  selected = i;
  applyHeldNotes();
  // Absolute knobs must be re-caught after a selection change. Relative
  // ones are keyed separately and are left alone.
  if (knobMode === 'pickup') {
    for (const [id, st] of knobState) if (!id.startsWith('rel:')) st.engaged = false;
  }
  clearCatching();
  renderPadHeads();
  refreshPadPanel();
}

function refreshPadPanel() {
  const pad = pads[selected];
  $('edit-title').textContent = `Pad ${selected + 1} — ${pad.name}`;
  $('btn-revert').disabled = !pad.original;
  $('filter-type').value = engine.voices[selected].filterType;
  $('sync-bars').value = String(engine.voices[selected].syncBars || 0);
  $('btn-dir').style.color = engine.voices[selected].dir < 0 ? 'var(--accent)' : '';
  buildParams();
}

// Touch and mouse want different things from a pad.
//
// With a mouse, dragging sculpts immediately — there is a scrollbar for
// scrolling. On a touch screen the pad covers most of the display, so a drag
// has to scroll the page or the instrument is unusable. That leaves a tap to
// play and a press-and-hold to take hold of the sound.
const HOLD_MS = 350;
const SLOP = 10;        // movement that still counts as a tap

function wirePad(pad) {
  const c = pad.canvas;
  const i = pad.index;
  let dragging = false;      // mouse
  let holdTimer = null;      // touch
  let grabbed = false;
  let startX = 0, startY = 0, moved = false;

  const apply = (e) => {
    const r = c.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const v = engine.voices[i];
    if (e.shiftKey) {
      v.set('pitch', denorm(PARAMS.pitch, x));
      v.set('grain', denorm(PARAMS.grain, 1 - y));
    } else {
      v.set('position', x);
      v.set('cutoff', denorm(PARAMS.cutoff, 1 - y));
    }
    if (i === selected) buildParams();
  };

  const grab = (e) => {
    grabbed = true;
    pad.el.classList.add('grabbed');
    // Only once the sound is actually being held does the pad stop the page
    // scrolling — up to that moment a drag has to belong to the page.
    c.style.touchAction = 'none';
    try { c.setPointerCapture(e.pointerId); } catch {}
    if (navigator.vibrate) navigator.vibrate(12);
    apply(e);
  };

  const letGo = (e) => {
    grabbed = false;
    pad.el.classList.remove('grabbed');
    c.style.touchAction = '';
    try { c.releasePointerCapture(e.pointerId); } catch {}
  };

  c.addEventListener('pointerdown', (e) => {
    select(i);
    if (e.pointerType !== 'touch') {
      dragging = true;
      c.setPointerCapture(e.pointerId);
      apply(e);
      return;
    }
    startX = e.clientX; startY = e.clientY; moved = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { if (!moved) grab(e); }, HOLD_MS);
  });

  c.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch') { if (dragging) apply(e); return; }
    if (grabbed) { apply(e); return; }
    if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) > SLOP) {
      // They are scrolling, not holding. Stand down and let the page have it.
      moved = true;
      clearTimeout(holdTimer);
    }
  });

  const endTouch = (e) => {
    if (e.pointerType !== 'touch') {
      dragging = false;
      try { c.releasePointerCapture(e.pointerId); } catch {}
      return;
    }
    clearTimeout(holdTimer);
    if (grabbed) { letGo(e); return; }
    // A tap that never became a hold or a scroll starts or stops the pad.
    if (!moved && pad.buffer) togglePad(i);
  };
  c.addEventListener('pointerup', endTouch);
  c.addEventListener('pointercancel', (e) => {
    clearTimeout(holdTimer);
    if (grabbed) letGo(e);
  });

  c.addEventListener('wheel', (e) => {
    e.preventDefault();
    const v = engine.voices[i];
    const dir = e.deltaY > 0 ? -1 : 1;
    if (e.shiftKey) v.set('reverbSend', v.p.reverbSend + dir * 0.04);
    else v.set('density', v.p.density * (dir > 0 ? 1.09 : 1 / 1.09));
    if (i === selected) buildParams();
  }, { passive: false });

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  pad.el.addEventListener('dragover', (e) => { stop(e); pad.el.classList.add('drop'); });
  pad.el.addEventListener('dragleave', (e) => { stop(e); pad.el.classList.remove('drop'); });
  pad.el.addEventListener('drop', async (e) => {
    stop(e);
    pad.el.classList.remove('drop');
    if (e.dataTransfer.files[0]) await loadFileToPad(e.dataTransfer.files[0], i);
  });
}

async function loadFileToPad(file, i) {
  try {
    const buf = await decodeFile(engine.ctx, file);
    const name = file.name.replace(/\.[^.]+$/, '');
    assignBuffer(i, buf, name, { kind: 'file', name: file.name });
    select(i);
  } catch (err) {
    console.error(err);
    $('st-status').textContent = `Could not decode ${file.name}`;
  }
}

/* ---------------- param editor ---------------- */

function buildParams() {
  const host = $('params');
  const v = engine.voices[selected];
  if (!host.children.length) {
    PARAM_ORDER.forEach((key, i) => {
      const spec = PARAMS[key];
      const knob = i < KNOB_TARGETS.length ? `<em class="kn">K${i + 1}</em>` : '';
      // The same markup twice: the base layer reads against the dark cell,
      // the `over` layer is black and clipped to the filled region.
      const el = document.createElement('div');
      el.className = 'par';
      el.dataset.k = key;
      el.innerHTML = `<div class="dialwrap"><div class="dial"><i class="knobmark"></i></div></div>
        <div class="txt">
          <div class="k"><span>${spec.label}</span>${knob}</div>
          <div class="n"><em class="val"></em><span>${spec.unit || ''}</span></div>
        </div>`;
      host.appendChild(el);
      wireParam(el, key, spec);
    });
  }
  for (const el of host.children) paintParam(el, v);
  lastStraight = null;          // force the greying to be re-evaluated
}

// What has nothing to do once the sound is playing straight.
const GRAIN_ONLY = ['grain', 'density', 'spray', 'reverse', 'detune'];

function paintParam(el, v) {
  const key = el.dataset.k;
  const spec = PARAMS[key];
  // On a locked pad the Cycle is the clock's, not its own — show what it
  // actually works out to rather than a number that is no longer in charge.
  if (key === 'cycle' && v.syncBars > 0) {
    const secs = v.syncBars * engine.transport.secondsPerBar;
    el.classList.add('synced');
    el.querySelector('.val').textContent = secs.toFixed(1);
    el.style.setProperty('--fill', norm(spec, Math.min(spec.max, secs)).toFixed(4));
    return;
  }
  el.classList.remove('synced');
  el.querySelector('.val').textContent = fmt(spec, v.p[key]);
  // 0..1, driving the conic sweep of the ring.
  el.style.setProperty('--fill', norm(spec, v.p[key]).toFixed(4));
}

/**
 * Position moves on its own — the read head is always travelling. Repaint it
 * every frame so it reads as the moving playhead it is, rather than looking
 * like it only creeps forward whenever you happen to touch a knob.
 */
let lastStraight = null;

function paintLiveParams() {
  const v = engine.voices[selected];
  const el = $('params').querySelector('.par[data-k=position]');
  if (el) paintParam(el, v);

  // Texture can be moved by a knob, a swell or a morph as well as by hand, so
  // the greying is checked here rather than only when the panel is rebuilt.
  // Guarded on a change so it is not touching the DOM every frame.
  const straight = v.p.texture <= 0.001;
  if (straight !== lastStraight) {
    lastStraight = straight;
    for (const cell of $('params').children) {
      cell.classList.toggle('inert', straight && GRAIN_ONLY.includes(cell.dataset.k));
    }
  }
}

function wireCols() {
  const sel = $('cols');
  const saved = localStorage.getItem(COLS_STORE);
  if (saved) sel.value = saved;
  const apply = () => {
    $('params').style.setProperty('--cols', sel.value);
    try { localStorage.setItem(COLS_STORE, sel.value); } catch {}
  };
  sel.addEventListener('change', apply);
  apply();
}

function wireParam(el, key, spec) {
  let dragging = false, lastY = 0, acc = 0;
  el.addEventListener('pointerdown', (e) => {
    dragging = true; lastY = e.clientY; acc = norm(spec, engine.voices[selected].p[key]);
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = lastY - e.clientY;
    lastY = e.clientY;
    acc += (dy / 220) * (e.shiftKey ? 0.25 : 1);
    engine.voices[selected].set(key, denorm(spec, acc));
    buildParams();
    if (key === 'cycle') renderPadHeads();
  });
  el.addEventListener('pointerup', (e) => {
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch {}
  });
}

/* ---------------- notes ---------------- */

function applyHeldNotes() {
  const midiNotes = midi ? [...midi.held].map((n) => n - 60) : [];
  const keys = [...qwertyHeld];
  engine.voices[selected].setNotes([...new Set([...midiNotes, ...keys])]);
}

/* ---------------- drawing ---------------- */

function fitCanvas(c, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = cssHeight ?? c.clientHeight;
  if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
    c.width = Math.floor(w * dpr);
    c.height = Math.floor(h * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawPad(pad) {
  const { ctx, w, h } = fitCanvas(pad.canvas);
  const v = engine.voices[pad.index];
  ctx.clearRect(0, 0, w, h);

  if (!pad.peaks) {
    ctx.fillStyle = THEME.faint;
    ctx.font = '11px ui-sans-serif,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('drop a file · forge · capture · live', w / 2, h / 2 + 4);
    return;
  }

  const mid = h / 2;
  const peaks = pad.peaks;
  const n = peaks.length;

  if (v.p.spray > 0.002) {
    const half = v.p.spray * w;
    ctx.fillStyle = THEME.accent2;
    ctx.globalAlpha = pad.on ? 0.14 : 0.06;
    ctx.fillRect(v.p.position * w - half, 0, half * 2, h);
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = pad.on ? THEME.wave : THEME.waveOff;
  ctx.globalAlpha = pad.on ? 0.9 : 0.5;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const p = peaks[Math.floor((x / w) * n)] || 0;
    const a = p * (mid - 3);
    ctx.moveTo(x + 0.5, mid - a);
    ctx.lineTo(x + 0.5, mid + a);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  const hx = v.p.position * w;
  ctx.strokeStyle = THEME.head;
  ctx.globalAlpha = pad.on ? 1 : 0.4;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(hx, 0);
  ctx.lineTo(hx, h);
  ctx.stroke();
  ctx.globalAlpha = 1;

  const t = norm(PARAMS.cutoff, v.p.cutoff);
  ctx.strokeStyle = THEME.accent;
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - t * h);
  ctx.lineTo(w, h - t * h);
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (v.notes.length) {
    ctx.fillStyle = THEME.accent2;
    ctx.font = '9px ui-monospace,monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${v.notes.length} held`, w - 5, 11);
  }
}

// Each voice is a body on its own orbit. The angle around the orbit is the
// pad's cycle position — that part is the real data. The orbit itself drifts:
// bodies tug on each other's shape as they pass, so the paths are never quite
// the same twice and the whole thing wanders without ever flying apart.
const ORBITS = Array.from({ length: PAD_COUNT }, () => ({
  // Scattered anywhere in the system rather than ranked by track number, so
  // the whole pane is populated from the first frame.
  a: 0.14 + Math.random() * 0.86,         // semi-major axis, 0..1 of the pane
  e: Math.random() * 0.85,                // eccentricity, circle to comet
  w: Math.random() * Math.PI * 2,         // orientation of the ellipse
  tilt: 0.55 + Math.random() * 0.45,      // how much vertical reach it uses
  aV: 0, eV: 0, wV: (Math.random() - 0.5) * 0.024,
  // Each orbit breathes on its own slow clock, so they swell through one
  // another instead of staying in their lanes.
  breathe: Math.random() * Math.PI * 2,
  breatheRate: 0.012 + Math.random() * 0.035,
  breatheDepth: 0.10 + Math.random() * 0.26,
  home: 0.16 + Math.random() * 0.8,
  // Shape drifts on its own even slower clock: a near-circle now, a long
  // ellipse in a few minutes, and back.
  eccPhase: Math.random() * Math.PI * 2,
  eccRate: 0.006 + Math.random() * 0.018,
  trail: [],
}));

function orbitPoint(o, theta, cx, cy, Rx, Ry) {
  // Kepler's polar form. The focus is the centre, so a body genuinely speeds
  // up as it swings past and slows at the far end.
  //
  // Normalised by (1 + e) so the far side stays inside the pane however
  // eccentric the orbit gets — the sun still sits at a focus, so the ellipse
  // is properly off-centre rather than merely squashed.
  const aEff = o.a / (1 + o.e);
  const r = (aEff * (1 - o.e * o.e)) / (1 + o.e * Math.cos(theta));
  const x = Math.cos(theta + o.w) * r * Rx;
  const y = Math.sin(theta + o.w) * r * Ry * o.tilt;
  return [cx + x, cy + y];
}

function stepOrbits(dt) {
  for (let i = 0; i < PAD_COUNT; i++) {
    const o = ORBITS[i];
    o.w += o.wV * dt * 6;
    // Gentle mutual perturbation: bodies on nearby orbits push each other's
    // radius and eccentricity apart, which keeps the picture restless.
    for (let j = 0; j < PAD_COUNT; j++) {
      if (i === j || !pads[j].on) continue;
      const d = ORBITS[j].a - o.a;
      const force = 0.0016 / (Math.abs(d) + 0.12);
      o.aV -= Math.sign(d) * force * dt;
      o.eV += (Math.random() - 0.5) * 0.0012 * dt;
    }
    // Springs back towards a home that is itself breathing in and out, so an
    // orbit expands and contracts through its neighbours over minutes.
    o.breathe += o.breatheRate * dt * Math.PI * 2;
    const home = Math.max(0.12, Math.min(1.0,
      o.home + Math.sin(o.breathe) * o.breatheDepth));
    o.aV += (home - o.a) * 0.3 * dt;
    // Eccentricity wanders the full range on its own clock, with the mutual
    // nudging riding on top of it.
    o.eccPhase += o.eccRate * dt * Math.PI * 2;
    const eHome = 0.45 + Math.sin(o.eccPhase) * 0.44;
    o.eV += (eHome - o.e) * 0.22 * dt;

    o.aV *= 0.985; o.eV *= 0.985;
    o.a = Math.max(0.08, Math.min(1.05, o.a + o.aV * dt));
    o.e = Math.max(0, Math.min(0.92, o.e + o.eV * dt));
  }
}

function drawPhase(dt) {
  const c = $('phase');
  const { ctx, w, h } = fitCanvas(c, c.clientHeight);
  ctx.clearRect(0, 0, w, h);
  stepOrbits(dt);

  const cx = w / 2, cy = h / 2;
  // The pane is square, so both reaches are the same and the orbits simply
  // use all of it. Each orbit's own tilt is what varies.
  const Rx = w * 0.47;
  const Ry = h * 0.47;
  const R = Math.min(Rx, Ry);
  const weight = Math.max(3.5, Math.min(w, h * 0.5) * 0.018);

  // The sun.
  const live = pads.filter((p) => p.on).length;
  const sun = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.24);
  sun.addColorStop(0, THEME.head);
  sun.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 0.16 + live * 0.045;
  ctx.fillStyle = sun;
  ctx.fillRect(cx - R * 0.24, cy - R * 0.24, R * 0.48, R * 0.48);
  ctx.globalAlpha = 1;

  for (let i = 0; i < PAD_COUNT; i++) {
    const o = ORBITS[i];
    const v = engine.voices[i];
    const on = pads[i].on;

    // The path.
    ctx.beginPath();
    for (let k = 0; k <= 72; k++) {
      const [x, y] = orbitPoint(o, (k / 72) * Math.PI * 2, cx, cy, Rx, Ry);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = on ? THEME.accent : THEME.line;
    ctx.globalAlpha = on ? 0.26 : 0.16;
    ctx.lineWidth = on ? weight * 0.42 : 1.2;
    ctx.stroke();

    const theta = v.p.position * Math.PI * 2;
    const [bx, by] = orbitPoint(o, theta, cx, cy, Rx, Ry);

    if (on) {
      o.trail.push([bx, by]);
      if (o.trail.length > 46) o.trail.shift();
      ctx.beginPath();
      o.trail.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = THEME.accent;
      ctx.globalAlpha = 0.34 + v.p.level * 0.44;
      ctx.lineWidth = weight * 1.25;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    } else if (o.trail.length) {
      o.trail.shift();
    }

    ctx.globalAlpha = 1;
    const rad = on ? weight * (1.1 + v.p.level * 0.9) : weight * 0.5;
    if (on) {
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, rad * 5);
      g.addColorStop(0, v.notes.length ? THEME.accent2 : THEME.accent);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = g;
      ctx.fillRect(bx - rad * 5, by - rad * 5, rad * 10, rad * 10);
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(bx, by, rad, 0, Math.PI * 2);
    ctx.fillStyle = on ? (v.notes.length ? THEME.accent2 : THEME.ink) : THEME.faint;
    ctx.fill();
  }
}

/** Is any part of this element within the viewport? */
function onScreen(el) {
  const r = el.getBoundingClientRect();
  return r.bottom > -120 && r.top < innerHeight + 120 && r.width > 0;
}

let lastFrameAt = performance.now();

function frame() {
  // Never let one bad frame stop the loop — the audio would keep running
  // with a frozen interface, which is the worst thing that could happen
  // in the middle of a set.
  try {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrameAt) / 1000) || 0.016;
    lastFrameAt = now;

    // Only draw what is actually on screen. On a phone the page is several
    // screens long, and repainting eight waveforms nobody can see is battery
    // spent for nothing.
    for (const pad of pads) if (onScreen(pad.canvas)) drawPad(pad);
    const phase = $('phase');
    if (phase.offsetParent !== null && onScreen(phase)) drawPhase(dt);
    paintLiveParams();
    paintBeats();

    $('meter-fill').style.width = `${Math.min(100, engine.level() * 100)}%`;
    $('grains').textContent = `${engine.grainCount()} grains`;

    if (input && input.enabled) $('in-fill').style.width = `${Math.min(100, input.level() * 140)}%`;
    if (recorder && recorder.recording) {
      const t = recorder.elapsed();
      $('rec-time').textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    }
  } catch (err) {
    console.error('frame', err);
  }
  requestAnimationFrame(frame);
}

/* ---------------- recording ---------------- */

/**
 * Capture to the selected pad from wherever you are. Enables the input first
 * if it has not been armed yet, so one key does the whole thing.
 */
async function captureNow() {
  if (!input) return;
  if (!input.enabled) {
    try { await input.enable(engine.reverbBus); } catch (err) {
      $('cap-badge').hidden = false;
      $('cap-badge').textContent = 'no mic';
      setTimeout(() => { $('cap-badge').hidden = true; }, 2500);
      return;
    }
    $('btn-mic').textContent = 'Input live';
    $('btn-mic').disabled = true;
    $('btn-capture').disabled = false;
    $('btn-live').disabled = false;
  }
  if (input.busy) return;
  const secs = +$('cap-len').value;
  const badge = $('cap-badge');
  badge.hidden = false;
  try {
    const buf = await input.capture(secs, (t) => {
      badge.textContent = `capturing ${t.toFixed(1)} / ${secs}s`;
    });
    assignBuffer(selected, buf, `Capture ${secs}s`, { kind: 'capture' });
    badge.textContent = `captured to pad ${selected + 1}`;
    $('cap-status').textContent = `Captured ${secs}s onto pad ${selected + 1}.`;
  } catch (err) {
    badge.textContent = `capture failed`;
  }
  setTimeout(() => { badge.hidden = true; }, 1800);
}

async function toggleRecord() {
  if (!recorder) return;
  const btn = $('btn-rec');
  if (!recorder.recording) {
    recorder.start();
    btn.classList.add('on');
    $('rec-label').textContent = 'Stop';
  } else {
    btn.classList.remove('on');
    $('rec-label').textContent = 'Encoding…';
    const { blob, seconds } = await recorder.stop();
    $('rec-label').textContent = 'Record';
    $('rec-time').textContent = '0:00';
    if (seconds < 0.5) return;
    download(blob, `ambient-${stamp()}.wav`);
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------- sources panel ---------------- */

function wireForge() {
  const kind = $('forge-kind');
  SEEDS.forEach((s) => kind.add(new Option(s.name, s.id)));
  const root = $('forge-root');
  ROOTS.forEach((r) => root.add(new Option(r.name, String(r.hz))));
  root.value = String(ROOTS[6].hz);

  $('forge-char').addEventListener('input', (e) => {
    $('forge-char-v').textContent = (+e.target.value).toFixed(2);
  });
  $('forge-len').addEventListener('input', (e) => {
    $('forge-len-v').textContent = `${e.target.value}s`;
  });

  $('btn-forge').addEventListener('click', () => {
    const opts = {
      root: +root.value,
      character: +$('forge-char').value,
      seconds: +$('forge-len').value,
    };
    const buf = generateSeed(engine.ctx, kind.value, opts);
    const label = SEEDS.find((s) => s.id === kind.value).name;
    const note = ROOTS.find((r) => String(r.hz) === root.value).name;
    assignBuffer(selected, buf, `${label} ${note}`, { kind: 'forge', gen: kind.value, ...opts });
  });
}

function wireInput() {
  $('cap-len').addEventListener('input', (e) => {
    $('cap-len-v').textContent = `${e.target.value}s`;
  });

  $('btn-mic').addEventListener('click', async () => {
    try {
      await input.enable(engine.reverbBus);
      $('btn-mic').textContent = 'Input live';
      $('btn-mic').disabled = true;
      $('btn-capture').disabled = false;
      $('btn-live').disabled = false;
      $('cap-status').textContent = 'Ready. Play or sing, then capture.';
      $('live-status').textContent = 'Send it to a pad and granulate it as you play.';
    } catch (err) {
      $('cap-status').textContent = `Microphone unavailable: ${err.message}`;
    }
  });

  $('cap-monitor').addEventListener('change', (e) => input.setMonitor(e.target.checked));

  $('btn-capture').addEventListener('click', async () => {
    const btn = $('btn-capture');
    const secs = +$('cap-len').value;
    btn.disabled = true;
    btn.classList.add('armed');
    try {
      const buf = await input.capture(secs, (t) => {
        btn.textContent = `Capturing… ${t.toFixed(1)}s / ${secs}s`;
      });
      assignBuffer(selected, buf, `Capture ${secs}s`, { kind: 'capture' });
      $('cap-status').textContent = `Captured ${secs}s onto pad ${selected + 1}.`;
    } catch (err) {
      $('cap-status').textContent = `Capture failed: ${err.message}`;
    }
    btn.textContent = 'Capture → selected pad';
    btn.classList.remove('armed');
    btn.disabled = false;
  });
}

/* ---------------- live granulation ---------------- */

function detachLive() {
  const i = pads.findIndex((p) => p.live);
  if (i < 0) return;
  pads[i].live = false;
  $('btn-freeze').disabled = true;
  $('btn-keep').disabled = true;
  $('btn-freeze').classList.remove('armed');
  $('btn-freeze').textContent = 'Freeze';
  if (liveBuf) liveBuf.setFrozen(false);
}

function wireLive() {
  $('live-window').addEventListener('input', (e) => {
    $('live-w-v').textContent = `${e.target.value}s`;
  });
  $('live-window').addEventListener('change', (e) => {
    if (liveBuf) liveBuf.setWindow(+e.target.value);
  });

  $('btn-live').addEventListener('click', async () => {
    const target = selected;
    detachLive();
    if (!liveBuf) {
      liveBuf = new LiveBuffer(engine.ctx, +$('live-window').value);
      liveBuf.onSwap((fwd, rev) => {
        const i = pads.findIndex((p) => p.live);
        if (i < 0) return;
        engine.voices[i].setLiveSource(fwd, rev);
        pads[i].buffer = fwd;
        pads[i].peaks = computePeaks(fwd, 240);
      });
      await liveBuf.attach(input.source);
    }
    const pad = pads[target];
    pad.live = true;
    pad.name = 'Live input';
    pad.source = { kind: 'live' };
    pad.original = null;
    liveBuf.refresh();
    if (!pad.on) togglePad(target);
    $('btn-freeze').disabled = false;
    $('btn-keep').disabled = false;
    $('live-status').textContent = `Pad ${target + 1} is reading the last ${$('live-window').value}s of input.`;
    renderPadHeads();
    refreshPadPanel();
  });

  $('btn-freeze').addEventListener('click', () => {
    const on = !liveBuf.frozen;
    liveBuf.setFrozen(on);
    $('btn-freeze').classList.toggle('armed', on);
    $('btn-freeze').textContent = on ? 'Frozen — release' : 'Freeze';
  });

  $('btn-keep').addEventListener('click', () => {
    const i = pads.findIndex((p) => p.live);
    if (i < 0) return;
    const buf = liveBuf.snapshot();
    detachLive();
    assignBuffer(i, buf, `Kept ${liveBuf.seconds}s`, { kind: 'capture' });
    $('live-status').textContent = `Window frozen onto pad ${i + 1} as a normal sample.`;
  });
}

/* ---------------- stretch ---------------- */

function wireStretch() {
  $('st-factor').addEventListener('input', (e) => {
    $('st-f-v').textContent = `×${e.target.value}`;
  });

  $('btn-stretch').addEventListener('click', async () => {
    const pad = pads[selected];
    if (!pad.buffer) { $('st-status').textContent = 'Nothing on this pad yet.'; return; }
    if (pad.live) { $('st-status').textContent = 'Keep the live window as a sample first.'; return; }

    const factor = +$('st-factor').value;
    const outSecs = pad.buffer.duration * factor;
    if (outSecs > 600) {
      $('st-status').textContent = `That would be ${Math.round(outSecs / 60)} minutes. Use a shorter source.`;
      return;
    }

    const btn = $('btn-stretch');
    btn.disabled = true;
    const original = pad.original || pad.buffer;
    try {
      const out = await paulStretch(engine.ctx, pad.buffer, factor, (p) => {
        $('st-status').textContent = `Stretching… ${Math.round(p * 100)}%`;
      });
      const name = pad.name;
      assignBuffer(selected, out, `${name} ×${factor}`, pad.source);
      pads[selected].original = original;
      $('btn-revert').disabled = false;
      $('st-status').textContent = `${outSecs.toFixed(0)}s of smear. Try a long Cycle and big grains.`;
    } catch (err) {
      console.error(err);
      $('st-status').textContent = `Stretch failed: ${err.message}`;
    }
    btn.disabled = false;
  });

  $('btn-revert').addEventListener('click', () => {
    const pad = pads[selected];
    if (!pad.original) return;
    const orig = pad.original;
    assignBuffer(selected, orig, pad.name.replace(/ ×\d+$/, ''), pad.source);
    $('st-status').textContent = 'Back to the original.';
  });
}

/* ---------------- space ---------------- */

// Rebuilding the impulse response means synthesising several seconds of
// stereo noise. A morph drives this every frame, so it has to be rate
// limited or it will bring the page down mid-performance.
let lastIR = { size: 0, decay: 0, dark: 0, at: 0 };

function applySpace(vals) {
  const size = vals['rv-size'], decay = vals['rv-decay'], dark = vals['rv-dark'];
  if (size != null && decay != null && dark != null) {
    const moved = Math.abs(size - lastIR.size) > 0.15
      || Math.abs(decay - lastIR.decay) > 0.08
      || Math.abs(dark - lastIR.dark) > 0.02;
    const now = performance.now();
    if (moved && now - lastIR.at > 400) {
      engine.setReverb({ size, decay, darkness: dark });
      lastIR = { size, decay, dark, at: now };
    }
  }
  engine.setDelay({ time: vals['dl-time'], feedback: vals['dl-fb'], tone: vals['dl-tone'] });
  // Land exactly on the target once the glide is over.
  if (vals.settle) { engine.setReverb({ size, decay, darkness: dark }); lastIR = { size, decay, dark, at: performance.now() }; }
  if (vals.master != null) engine.setMaster(vals.master);
  for (const [k, v] of Object.entries(vals)) {
    const el = $(k);
    if (el) el.value = v;
  }
  syncSpaceLabels();
}

function syncSpaceLabels() {
  $('v-size').textContent = `${(+$('rv-size').value).toFixed(1)}s`;
  $('v-decay').textContent = (+$('rv-decay').value).toFixed(1);
  $('v-dark').textContent = (+$('rv-dark').value).toFixed(2);
  $('v-dtime').textContent = `${(+$('dl-time').value).toFixed(2)}s`;
  $('v-dfb').textContent = (+$('dl-fb').value).toFixed(2);
  $('v-dtone').textContent = `${(+$('dl-tone').value).toFixed(0)}Hz`;
}

function wireSpace() {
  const rebuildIR = () => engine.setReverb({
    size: +$('rv-size').value, decay: +$('rv-decay').value, darkness: +$('rv-dark').value,
  });
  const on = (id, fn) => $(id).addEventListener('input', () => { syncSpaceLabels(); fn(); });
  on('rv-size', rebuildIR);
  on('rv-decay', rebuildIR);
  on('rv-dark', rebuildIR);
  on('dl-time', () => engine.setDelay({ time: +$('dl-time').value }));
  on('dl-fb', () => engine.setDelay({ feedback: +$('dl-fb').value }));
  on('dl-tone', () => engine.setDelay({ tone: +$('dl-tone').value }));
  $('master').addEventListener('input', (e) => engine.setMaster(+e.target.value));
}

/* ---------------- scenes ---------------- */

function buildSlots() {
  const host = $('slots');
  host.innerHTML = '';
  SLOT_NAMES.forEach((name, i) => {
    const el = document.createElement('div');
    el.className = 'slot' + (slots[i] ? ' full' : '');
    el.innerHTML = `<i class="prog"></i>
      <div class="nm">${name}</div>
      <div class="btns">
        <button data-a="store">Store</button>
        <button data-a="morph" ${slots[i] ? '' : 'disabled'}>Morph</button>
      </div>`;
    el.querySelector('[data-a=store]').addEventListener('click', () => {
      slots[i] = captureState(engine, pads);
      markActiveScene(i);       // you are, by definition, on it now
      buildSlots();
    });
    el.querySelector('[data-a=morph]').addEventListener('click', () => goToScene(i));
    host.appendChild(el);
  });
  paintSlots();
}

/** Called on state changes and while a morph runs; no DOM rebuild. */
function paintSlots() {
  const host = $('slots');
  [...host.children].forEach((el, i) => {
    el.classList.toggle('active', activeScene === i && morphTarget !== i);
    el.classList.toggle('morphing', morphTarget === i);
    el.querySelector('.prog').style.width = morphTarget === i ? `${morphProgress * 100}%` : '0';
    const dot = el.querySelector('.edited');
    const show = activeScene === i && morphTarget === null && sceneEdited;
    if (show && !dot) {
      const d = document.createElement('i');
      d.className = 'edited';
      d.title = 'Changed since you landed on this scene';
      el.appendChild(d);
    } else if (!show && dot) dot.remove();
  });
}

function goToScene(i) {
  if (!slots[i]) return;
  morphTarget = i;
  morphProgress = 0;
  morpher.start(structuredClone(slots[i]), +$('morph-time').value);
  paintSlots();
}

/**
 * Everything that defines a scene except `position`, which drifts on its own
 * and would otherwise report the state as edited a few milliseconds after
 * every landing.
 */
function stateSignature(state) {
  return JSON.stringify(state.voices.map((v) => {
    const { position, ...rest } = v.p;
    return [v.on, v.dir, rest];
  })) + JSON.stringify(state.space);
}

// Cached so the comparison only has to serialise the live state.
let activeSignature = null;
let lastEditCheck = 0;

function markActiveScene(i) {
  activeScene = i;
  sceneEdited = false;
  activeSignature = i === null || !slots[i] ? null : stateSignature(slots[i]);
}

/**
 * Timed off the audio clock rather than a tick count — `setInterval` is
 * throttled hard in a background tab, and counting ticks there would stretch
 * a half-second check out to fifteen seconds.
 */
function checkSceneEdited() {
  const t = engine.ctx.currentTime;
  if (t - lastEditCheck < 0.4) return;
  lastEditCheck = t;
  if (activeScene === null || !activeSignature || morpher.running) return;
  const dirty = stateSignature(captureState(engine, pads)) !== activeSignature;
  if (dirty !== sceneEdited) {
    sceneEdited = dirty;
    paintSlots();
  }
}

function wireScenes() {
  $('morph-time').addEventListener('input', (e) => {
    $('morph-v').textContent = `${e.target.value}s`;
  });

  // Keep the size of a save visible, since embedding audio is what makes a
  // session big — and what makes it complete.
  const refreshSize = () => {
    const bytes = audioSize(pads);
    $('save-audio-size').textContent = bytes
      ? `${(bytes / 1048576).toFixed(1)} MB of audio` : 'nothing recorded yet';
  };
  $('btn-save').addEventListener('pointerenter', refreshSize);
  $('save-audio').addEventListener('change', refreshSize);
  refreshSize();

  $('btn-save').addEventListener('click', () => {
    const withAudio = $('save-audio').checked;
    const { json, embedded, bytes } = serialize(slots, engine, pads, withAudio);
    const blob = new Blob([json], { type: 'application/json' });
    download(blob, `ambient-session-${stamp()}.json`);
    const mb = (blob.size / 1048576).toFixed(1);
    $('session-status').textContent = embedded
      ? `Saved with ${embedded} recorded source${embedded > 1 ? 's' : ''} (${mb} MB).`
      : `Saved (${mb} MB). No recorded audio to embed.`;
  });

  $('btn-open').addEventListener('click', () => $('session-input').click());
  $('session-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = deserialize(await file.text());
      data.slots.forEach((s, i) => { slots[i] = s; });

      // Embedded audio first — it is the only copy of anything recorded.
      const restored = await decodeAudio(engine.ctx, data);
      const missing = [];
      data.sources.forEach((s, i) => {
        if (restored[i]) {
          assignBuffer(i, restored[i], s.name, s.source);
        } else if (s.source && s.source.kind === 'forge') {
          assignBuffer(i, generateSeed(engine.ctx, s.source.gen, s.source), s.name, s.source);
        } else if (s.source) {
          missing.push(s.source.name || s.name);
        }
      });

      morphTarget = null;
      markActiveScene(null);
      morpher.start(structuredClone(data.current), 0.05);
      buildSlots();
      const n = Object.keys(restored).length;
      $('session-status').textContent = missing.length
        // Say so loudly. Silently dropping a source is how a recording is lost.
        ? `Loaded, but ${missing.length} source could not be restored: ${missing.join(', ')}. `
          + 'That session was saved without embedded audio.'
        : `Session loaded${n ? ` with ${n} recorded source${n > 1 ? 's' : ''}` : ''}.`;
    } catch (err) {
      console.error(err);
      $('session-status').textContent = `Could not open: ${err.message}`;
    }
  });
}

/* ---------------- freesound ---------------- */

function wireFreesound() {
  $('fs-key').value = freesound.getKey();
  $('fs-key').addEventListener('change', (e) => freesound.setKey(e.target.value));

  const run = async () => {
    const q = $('fs-q').value.trim();
    if (!q) return;
    freesound.setKey($('fs-key').value);
    $('fs-status').textContent = 'Searching…';
    try {
      fsResults = await freesound.search(q);
      renderResults();
      $('fs-status').textContent = `${fsResults.length} results. Click one to load it.`;
    } catch (err) {
      $('fs-results').innerHTML = '';
      $('fs-status').textContent = err.message;
    }
  };

  $('btn-fs').addEventListener('click', run);
  $('fs-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

function renderResults() {
  const host = $('fs-results');
  host.innerHTML = '';
  fsResults.forEach((r) => {
    const el = document.createElement('div');
    el.className = 'res';
    el.innerHTML = `<b>${r.name}</b><span>${r.duration.toFixed(0)}s · ${r.user} · ${r.license.split('/').slice(-3, -2)[0] || 'cc'}</span>`;
    el.addEventListener('click', async () => {
      $('fs-status').textContent = `Loading ${r.name}…`;
      try {
        const buf = await freesound.load(engine.ctx, r);
        assignBuffer(selected, buf, r.name.slice(0, 28), { kind: 'file', name: r.name, from: r.page });
        $('fs-status').textContent = `Loaded onto pad ${selected + 1}. Credit: ${r.user} — ${r.page}`;
      } catch (err) {
        $('fs-status').textContent = err.message;
      }
    });
    host.appendChild(el);
  });
}

/* ---------------- midi ---------------- */

function buildKnobMap() {
  const padHost = $('padmap');
  padHost.innerHTML = '';
  for (let i = 0; i < PAD_COUNT; i++) {
    const note = midi.map.pads[i];
    const el = document.createElement('div');
    el.className = 'km' + (note != null ? ' mapped' : '');
    el.innerHTML = `<div class="k">Pad ${i + 1}</div>
      <div class="cc">${note != null ? noteName(note) : 'unmapped'}</div>`;
    padHost.appendChild(el);
  }

  const host = $('knobmap');
  host.innerHTML = '';
  KNOB_TARGETS.forEach((key, i) => {
    const cc = midi.map.knobs[i];
    const el = document.createElement('div');
    el.className = 'km' + (cc != null ? ' mapped' : '');
    el.innerHTML = `<div class="k">K${i + 1} · ${PARAMS[key].label}</div>
      <div class="cc">${cc != null ? `CC ${cc}` : 'unmapped'}</div>`;
    host.appendChild(el);
  });

  const scenes = $('scenemap');
  scenes.innerHTML = '';
  SLOT_NAMES.forEach((name, i) => {
    const note = midi.map.scenes[i];
    const el = document.createElement('div');
    el.className = 'km' + (note != null ? ' mapped' : '');
    el.innerHTML = `<div class="k">Scene ${name}</div>
      <div class="cc">${note != null ? noteName(note) : 'unmapped'}</div>`;
    scenes.appendChild(el);
  });

  const launchHost = $('launchmap');
  launchHost.innerHTML = '';
  for (let i = 0; i < PAD_COUNT; i++) {
    const note = (midi.map.launch || [])[i];
    const el = document.createElement('div');
    el.className = 'km' + (note != null ? ' mapped' : '');
    el.innerHTML = `<div class="k">Launch ${i + 1}</div>
      <div class="cc">${note != null ? noteName(note) : 'unmapped'}</div>`;
    launchHost.appendChild(el);
  }
  buildMacroMap();
  buildFxMap();
  buildBankMap();

  const c = midi.counts();
  const any = c.pads + c.knobs + c.scenes + c.launch + c.macros + c.banks + c.fx > 0;
  $('btn-midi-save').disabled = !any;
  $('btn-midi-clear').disabled = !any;
  $('btn-preset-save').disabled = !any;

  // A restored mapping with no device bound is the confusing case — say so
  // rather than letting a populated grid imply it is live.
  const warn = $('map-warning');
  if (warn) {
    let msg = '';
    if (midi.connected && !midi.map.pads.length) {
      // Without a pad map, incoming notes fall through to the chord handler
      // and show up as "held" on the pad instead of switching anything.
      msg = 'No pads learned yet — notes from your controller are being played '
          + 'as chord notes into the selected pad. Press Learn 8 pads.';
    }
    if (midi.access && !midi.inputs.length) {
      msg = 'Browser has MIDI access but sees no input ports. Check the controller is '
          + 'plugged in and not held exclusively by another program, then press Retry connect.';
    } else if (any && !midi.connected) {
      msg = 'Mapping restored from your last session, but no device is connected yet — press Connect MIDI.';
    }
    warn.textContent = msg;
    warn.style.display = msg ? '' : 'none';
  }
}

// Anything a swell can lean on. Level and Tone are the obvious ones; Density
// and Grain are where it gets interesting.
const SWELL_TARGETS = ['level', 'density', 'cutoff', 'grain', 'spray', 'sweep',
  'reverbSend', 'delaySend', 'detune', 'spread', 'cycle'];

// Anything a whole row of controls can be pointed at.
const BANK_TARGETS = ['level', 'cycle', 'grain', 'density', 'cutoff', 'rate', 'sweep',
  'spray', 'pitch', 'detune', 'spread', 'reverbSend', 'delaySend', 'attack', 'release'];
const BANK_ACTIONS = [['toggle', 'start / stop'], ['focus', 'focus track']];

function flashBank(bank) {
  const i = midi.map.banks.indexOf(bank);
  const el = $('bankmap').children[i];
  if (!el) return;
  el.classList.add('hit');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('hit'), 220);
}

function buildBankMap() {
  const host = $('bankmap');
  host.innerHTML = '';
  (midi.map.banks || []).forEach((bank, i) => {
    const el = document.createElement('div');
    el.className = 'bank';
    const what = bank.kind === 'cc' ? `CC ${bank.ids.join(' ')}` : bank.ids.map(noteName).join(' ');
    el.innerHTML = `<div class="bk"><em>${bank.device || 'any device'}</em> · ${what}</div>
      <select class="b-target"></select>
      <select class="b-focus">
        <option value="1">focus</option>
        <option value="0">no focus</option>
      </select>
      <button class="rm" title="Remove">&times;</button>`;
    const sel = el.querySelector('.b-target');
    if (bank.kind === 'cc') {
      for (const key of BANK_TARGETS) sel.add(new Option(PARAMS[key].label, key));
      sel.value = bank.param;
      sel.addEventListener('change', () => { bank.param = sel.value; midi.save(); });
    } else {
      for (const [v, label] of BANK_ACTIONS) sel.add(new Option(label, v));
      sel.value = bank.action;
      sel.addEventListener('change', () => { bank.action = sel.value; midi.save(); });
      el.querySelector('.b-focus').disabled = true;
    }
    el.querySelector('.b-focus').value = bank.focus ? '1' : '0';
    el.querySelector('.b-focus').addEventListener('change', (e) => {
      bank.focus = e.target.value === '1'; midi.save();
    });
    el.querySelector('.rm').addEventListener('click', () => {
      midi.removeBank(i); buildKnobMap();
    });
    host.appendChild(el);
  });
}

function buildFxMap() {
  const host = $('fxmap');
  host.innerHTML = '';
  (midi.map.fx || []).forEach((a, i) => {
    const el = document.createElement('div');
    el.className = 'macro mapped';
    el.innerHTML = `<span class="mk">${noteName(a.note)}</span>
      <select class="f-effect"></select>
      <span></span>
      <select class="f-scope">
        <option value="selected">this pad</option>
        <option value="all">all live</option>
      </select>`;
    const sel = el.querySelector('.f-effect');
    for (const [key, def] of Object.entries(EFFECTS)) sel.add(new Option(def.label, key));
    sel.value = a.effect;
    sel.title = EFFECTS[a.effect] ? EFFECTS[a.effect].hint : '';
    el.querySelector('.f-scope').value = a.scope;
    sel.addEventListener('change', () => {
      a.effect = sel.value;
      sel.title = EFFECTS[a.effect].hint;
      midi.save();
    });
    el.querySelector('.f-scope').addEventListener('change', (e) => {
      a.scope = e.target.value; midi.save();
    });
    host.appendChild(el);
  });
}

function buildMacroMap() {
  const host = $('macromap');
  host.innerHTML = '';
  (midi.map.macros || []).forEach((m, i) => {
    const el = document.createElement('div');
    el.className = 'macro mapped';
    el.innerHTML = `<span class="mk">${noteName(m.note)}</span>
      <select class="m-param"></select>
      <input class="m-amt" type="range" min="-1" max="1" step="0.05" value="${m.amount}">
      <select class="m-scope">
        <option value="selected">this pad</option>
        <option value="all">all live</option>
      </select>`;
    const sel = el.querySelector('.m-param');
    for (const key of SWELL_TARGETS) sel.add(new Option(PARAMS[key].label, key));
    sel.value = m.param;
    el.querySelector('.m-scope').value = m.scope;

    sel.addEventListener('change', () => { m.param = sel.value; midi.save(); });
    el.querySelector('.m-amt').addEventListener('input', (e) => {
      m.amount = +e.target.value; midi.save();
    });
    el.querySelector('.m-scope').addEventListener('change', (e) => {
      m.scope = e.target.value; midi.save();
    });
    host.appendChild(el);
  });
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(n) {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

function onKnob(slot, v01) {
  const key = KNOB_TARGETS[slot];
  const spec = PARAMS[key];
  const voice = engine.voices[selected];
  // Relative knobs are keyed per slot, not per pad — the offset is what
  // matters, so there is nothing to re-catch when the selection changes.
  const relative = knobMode === 'relative' || RELATIVE.has(key);
  const id = relative ? `rel:${slot}` : `${selected}:${slot}`;
  const st = knobState.get(id) || { engaged: knobMode === 'jump', last: v01 };

  if (relative) {
    const delta = v01 - st.last;
    st.last = v01;
    knobState.set(id, st);
    if (delta === 0) return;
    // Nudge in normalised space, so a relative knob moves a log parameter
    // like Tone or Cycle by musical proportion rather than raw Hz.
    voice.set(key, denorm(spec, norm(spec, voice.p[key]) + delta));
  } else if (knobMode === 'jump') {
    st.engaged = true;
    st.last = v01;
    knobState.set(id, st);
    voice.set(key, denorm(spec, v01));
  } else {
    if (!st.engaged) {
      // Engage once the knob passes through the value it is taking over, so
      // switching pads mid-set does not make every parameter jump.
      const c = cur(spec, voice, key);
      const crossed = (st.last - c) * (v01 - c) <= 0;
      if (crossed || Math.abs(v01 - c) < 0.03) st.engaged = true;
    }
    st.last = v01;
    knobState.set(id, st);
    // Show where the knob is sitting while it waits, so an inert knob reads
    // as "not caught yet" rather than as a dead control.
    markCatching(key, st.engaged ? null : v01);
    if (!st.engaged) return;
    voice.set(key, denorm(spec, v01));
  }

  buildParams();
  if (key === 'cycle') renderPadHeads();
}

function markCatching(key, v01) {
  const el = $('params').querySelector(`.par[data-k="${key}"]`);
  if (!el) return;
  el.classList.toggle('catching', v01 !== null);
  if (v01 !== null) el.style.setProperty('--knob', v01.toFixed(4));
}

function clearCatching() {
  for (const el of $('params').querySelectorAll('.par.catching')) el.classList.remove('catching');
}

function wireSize() {
  const sel = $('ui-size');
  const saved = localStorage.getItem(SIZE_STORE);
  if (saved) sel.value = saved;
  const apply = () => {
    document.documentElement.style.setProperty('--ui-scale', sel.value);
    try { localStorage.setItem(SIZE_STORE, sel.value); } catch {}
  };
  sel.addEventListener('change', apply);
  apply();
}

// Everything neutral: the sample as recorded, a touch of space, nothing
// moving. Not a mode — a starting position. Raise Texture from here and the
// grains come back in over the top of it, which is the point.
//
// The grain settings are left somewhere sensible rather than at zero, so the
// first nudge of Texture gives something musical instead of a mess.
const PLAIN = {
  texture: 0,
  pitch: 0, detune: 0.1, reverse: 0, spray: 0.04, spread: 0.4,
  cutoff: 18000, sweep: 0, rate: 0.07,
  reverbSend: 0.14, delaySend: 0, level: 0.85,
  attack: 0.06, release: 0.25,
  grain: 240, density: 14,
};

function makePlain() {
  const v = engine.voices[selected];
  v.setFilterType('lowpass');
  v.dir = 1;
  for (const [k, val] of Object.entries(PLAIN)) v.set(k, val);
  // The read head travels the sample once at its natural speed, so raising
  // Texture grains the part you are actually hearing.
  if (pads[selected].buffer) {
    v.set('cycle', Math.min(PARAMS.cycle.max, pads[selected].buffer.duration));
  }
  refreshPadPanel();
  renderPadHeads();
}

function wirePlayMode() {
  $('btn-plain').addEventListener('click', makePlain);
}

function wireFilterType() {
  $('filter-type').addEventListener('change', (e) => {
    engine.voices[selected].setFilterType(e.target.value);
  });
}

function wireKnobMode() {
  const sel = $('knob-mode');
  const saved = localStorage.getItem(KNOBMODE_STORE);
  if (saved) sel.value = saved;
  const apply = () => {
    knobMode = sel.value;
    try { localStorage.setItem(KNOBMODE_STORE, knobMode); } catch {}
    knobState.clear();
    clearCatching();
  };
  sel.addEventListener('change', apply);
  apply();
}

function cur(spec, voice, key) { return norm(spec, voice.p[key]); }

let monTimer = null;

function wireMidi() {
  midi = new Midi({
    // A pad grabs its track for the knobs; hitting the one you are already
    // on is what actually switches it. Stops you killing a voice when all
    // you wanted was to get your hands on its parameters.
    onPad: (i) => { if (i === selected) togglePad(i); else select(i); },
    // A chord of launch keys is one decision for the whole group: if every
    // pad in it is already on they all go out, otherwise they all come in.
    // Toggling each one would leave the group half lit.
    onLaunch: (group) => {
      const idx = group.filter((i) => pads[i] && pads[i].buffer);
      if (!idx.length) return;
      const allOn = idx.every((i) => pads[i].on);
      for (const i of idx) {
        if (allOn && pads[i].on) { pads[i].on = false; engine.voices[i].stop(); }
        else if (!allOn && !pads[i].on) { pads[i].on = true; engine.voices[i].start(); }
      }
      renderPadHeads();
    },
    onEffect: (i, down) => {
      const a = midi.map.fx[i];
      if (!a) return;
      if (down) effects.press(i, a, selected); else effects.release(i);
      const el = $('fxmap').children[i];
      if (el) el.classList.toggle('firing', down);
      buildParams();
    },
    onMacro: (i, down) => {
      const m = midi.map.macros[i];
      if (!m) return;
      if (down) swells.press(i, m, selected); else swells.release(i);
      const el = $('macromap').children[i];
      if (el) el.classList.toggle('firing', down);
    },
    // A bank control owns its track outright, so it never needs to catch a
    // value first — it is the only thing driving that parameter on that track.
    onBank: (bank, track, v01) => {
      const pad = pads[track];
      const voice = engine.voices[track];
      if (!pad || !voice) return;

      if (bank.kind === 'note') {
        if (v01 <= 0) return;                       // act on press, not release
        if (bank.action === 'focus') select(track);
        else if (bank.action === 'toggle') {
          if (!pad.buffer) { select(track); return; }
          pad.on = !pad.on;
          if (pad.on) voice.start(); else voice.stop();
          renderPadHeads();
        }
        return;
      }

      const spec = PARAMS[bank.param];
      if (!spec) return;
      voice.set(bank.param, denorm(spec, v01));
      // Touching a track's control brings it up on screen, so what you are
      // turning is what you are looking at.
      if (bank.focus && track !== selected) select(track);
      if (track === selected) buildParams();
      if (bank.param === 'cycle') renderPadHeads();
      flashBank(bank);
    },
    onScene: (i) => {
      if (!slots[i]) { $('learn-status').textContent = `Scene ${SLOT_NAMES[i]} is empty.`; return; }
      goToScene(i);
      $('learn-status').textContent = `Morphing to scene ${SLOT_NAMES[i]}.`;
    },
    onNotes: () => applyHeldNotes(),
    onKnob,
    // Fires on the initial bind and on every hot-plug. It drives exactly the
    // same UI update as pressing Connect, so a controller plugged in after
    // the page loaded arms the learn buttons like any other.
    onStatus: (name, count) => onConnected({ name, count }),
    // The decisive diagnostic: if this stays empty while you wiggle a knob,
    // nothing is reaching the page and no amount of mapping will help.
    onActivity: (text, count, device) => {
      const el = $('mon-last');
      el.textContent = device ? `${device} — ${text}` : text;
      el.classList.add('live');
      $('mon-count').textContent = count;
      clearTimeout(monTimer);
      monTimer = setTimeout(() => el.classList.remove('live'), 400);
    },
    onLearn: (kind, n, total, stolen) => {
      $('learn-status').textContent = (stolen ? `Taken from ${stolen}. ` : '') + (kind
        ? `Learning ${kind}: ${n} of ${total} — ${kind === 'knobs' || kind === 'bank' ? 'move' : 'hit'} the next one, in track order. `
          + 'Press the button again to cancel; your saved mapping is kept until a full set is captured.'
        : 'Mapped and saved.');
      for (const bid of ['btn-learn-pads', 'btn-learn-knobs', 'btn-learn-scenes',
        'btn-learn-launch', 'btn-learn-macros', 'btn-learn-fx', 'btn-learn-bank']) {
        if (!kind) $(bid).classList.remove('armed');
      }
      buildKnobMap();
    },
  });

  // Only claim a connection when inputs were actually found. Saying
  // "connected" with nothing bound is what made this look like a mapping
  // problem when it was a device problem.
  const onConnected = ({ name, count }) => {
    const live = count > 0;
    $('btn-midi').textContent = live ? 'MIDI connected' : 'Retry connect';
    $('btn-midi').disabled = live;
    $('btn-learn-pads').disabled = !live;
    $('btn-learn-knobs').disabled = !live;
    $('btn-learn-scenes').disabled = !live;
    $('btn-learn-launch').disabled = !live;
    $('btn-learn-macros').disabled = !live;
    $('btn-learn-bank').disabled = !live;
    $('btn-learn-fx').disabled = !live;
    $('midi-status').textContent = live ? `${count} input${count > 1 ? 's' : ''} — ${name}` : 'no inputs found';
    buildKnobMap();
  };

  $('btn-midi').addEventListener('click', async () => {
    try {
      onConnected(await midi.enable());
    } catch (err) {
      $('midi-status').textContent = err.message;
    }
  });

  // If access was granted in an earlier session, rebind silently. Without
  // this the restored mapping is displayed but nothing is listening, which
  // looks exactly like a working setup that has stopped working.
  midi.autoEnable().then((res) => {
    if (res) onConnected(res);
  }).catch(() => {});

  $('btn-preset-save').addEventListener('click', () => {
    const blob = new Blob([midi.toPreset()], { type: 'application/json' });
    download(blob, `ambient-midi-${stamp()}.json`);
  });
  $('btn-preset-load').addEventListener('click', () => $('preset-input').click());
  $('preset-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const c = midi.fromPreset(await file.text());
      buildKnobMap();
      $('save-status').textContent =
        `Preset loaded — ${c.pads} pads, ${c.knobs} knobs, ${c.scenes} scene keys.`;
    } catch (err) {
      $('save-status').textContent = `Could not load preset: ${err.message}`;
    }
  });

  const learnBtn = (id, kind) => $(id).addEventListener('click', () => {
    // Pressing an armed learn button again backs out, leaving the previous
    // mapping untouched.
    if (midi.learn === kind) midi.cancelLearn(); else midi.startLearn(kind);
    for (const [bid, k] of [['btn-learn-pads', 'pads'], ['btn-learn-knobs', 'knobs'],
      ['btn-learn-scenes', 'scenes'], ['btn-learn-launch', 'launch'],
      ['btn-learn-macros', 'macros'], ['btn-learn-fx', 'fx'], ['btn-learn-bank', 'bank']]) {
      $(bid).classList.toggle('armed', midi.learn === k);
    }
  });
  learnBtn('btn-learn-pads', 'pads');
  learnBtn('btn-learn-knobs', 'knobs');
  learnBtn('btn-learn-scenes', 'scenes');
  learnBtn('btn-learn-launch', 'launch');
  learnBtn('btn-learn-macros', 'macros');
  learnBtn('btn-learn-fx', 'fx');
  learnBtn('btn-learn-bank', 'bank');

  // Learning all eight saves on its own, but a partial mapping is worth
  // keeping too — and it should be obvious that it was kept.
  $('btn-midi-save').addEventListener('click', () => {
    const c = midi.counts();
    $('save-status').textContent = midi.save()
      ? `Saved — ${c.pads} pads, ${c.knobs} knobs, ${c.scenes} scene keys.`
      : 'Could not save: browser storage is unavailable.';
  });
  $('btn-midi-clear').addEventListener('click', () => {
    midi.clear();
    buildKnobMap();
    $('save-status').textContent = 'Mapping cleared.';
  });
  buildKnobMap();
}

/* ---------------- transport ---------------- */

function wireTransport() {
  const t = engine.transport;

  $('btn-clock').addEventListener('click', () => {
    t.toggle();
    $('btn-clock').classList.toggle('on', t.running);
  });
  $('btn-metro').addEventListener('click', () => {
    t.metronome = !t.metronome;
    $('btn-metro').classList.toggle('on', t.metronome);
    // A click with no clock running is just silence, so start it.
    if (t.metronome && !t.running) $('btn-clock').click();
  });
  $('bpm').addEventListener('change', (e) => t.setBpm(+e.target.value));
  $('bpb').addEventListener('change', (e) => { t.setBeatsPerBar(+e.target.value); buildBeats(); });

  $('sync-bars').addEventListener('change', (e) => {
    const v = +e.target.value;
    const voice = engine.voices[selected];
    voice.syncBars = v;
    // Re-launch a straight loop on the next downbeat, so locking it to the
    // bar actually puts it on the bar.
    if (voice.loop && voice.playing && v > 0 && t.running) {
      voice.stopLoop();
      voice.startLoop(t.nextDownbeat(), t);
    }
    // Locking a pad only means anything if the clock is running.
    if (v > 0 && !t.running) $('btn-clock').click();
    buildParams();
    renderPadHeads();
  });
  buildBeats();
}

function buildBeats() {
  const host = $('beats');
  host.innerHTML = '';
  for (let i = 0; i < engine.transport.beatsPerBar; i++) {
    const el = document.createElement('i');
    if (i === 0) el.className = 'down';
    host.appendChild(el);
  }
}

/** Called every frame; cheap enough and keeps the beat lamps honest. */
function paintBeats() {
  const t = engine.transport;
  const host = $('beats');
  if (!t.running) {
    for (const el of host.children) el.classList.remove('on');
    return;
  }
  const beat = Math.floor(t.beats()) % t.beatsPerBar;
  [...host.children].forEach((el, i) => el.classList.toggle('on', i === beat));
}

/* ---------------- world clock ---------------- */

function fmtClock(sec) {
  const m = Math.floor(sec / 60), r = Math.round(sec % 60);
  return m ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
}

/**
 * Shows where the light is in the world, and how long until it turns. This is
 * the point of the whole link: you can see the sunset coming and bring the
 * next scene in to meet it.
 */
function paintWorldClock(w) {
  const el = $('world-clock');
  if (!w) { el.hidden = true; return; }
  el.hidden = false;
  const next = w.next;
  el.className = 'wclock';
  if (next && next.seconds < 20) el.classList.add('imminent');
  else if (next && next.seconds < 75) el.classList.add('soon');
  el.innerHTML = `<b>${w.phase}</b>`
    + (next ? `<i>${next.to} in ${fmtClock(next.seconds)}</i>` : '<i>holding</i>')
    + (w.status ? `<i>· ${w.status}</i>` : '');
}

/* ---------------- panic ---------------- */

let lastStop = 0;

/**
 * First press fades everything out musically. A second press within a couple
 * of seconds means it is still making noise and you want it gone now, so cut
 * the master and flush the delay line as well.
 */
function stopAll() {
  const now = performance.now();
  const hard = now - lastStop < 2000;
  lastStop = now;

  morpher.cancel();
  qwertyHeld.clear();
  if (midi) midi.held.clear();

  engine.voices.forEach((v, i) => {
    v.setNotes([]);
    if (pads[i].on) { pads[i].on = false; v.stop(); }
  });
  if (hard) engine.panic();
  effects.clear();

  const btn = $('btn-stop');
  btn.classList.add('armed');
  setTimeout(() => btn.classList.remove('armed'), hard ? 1200 : 400);
  renderPadHeads();
}

/* ---------------- tabs & keys ---------------- */

function showTab(btn) {
  if (!btn) return;
  for (const t of $('tabs').children) t.classList.toggle('on', t === btn);
  for (const s of document.querySelectorAll('.sheet')) {
    s.classList.toggle('hidden', s.dataset.sheet !== btn.dataset.tab);
  }
}

/** @param {number} step -1 or +1, wrapping — however many tabs there end up being. */
function stepTab(step) {
  const tabs = [...$('tabs').children];
  const at = tabs.findIndex((t) => t.classList.contains('on'));
  showTab(tabs[(at + step + tabs.length) % tabs.length]);
}

function wireTabs() {
  $('tabs').addEventListener('click', (e) => showTab(e.target.closest('.tab')));
}

function wireGlobal() {
  $('btn-rec').addEventListener('click', toggleRecord);
  $('btn-stop').addEventListener('click', stopAll);
  $('btn-viz').addEventListener('click', () => {
    window.open('viz.html', 'ambient-viz', 'width=1280,height=720');
  });
  $('btn-help').addEventListener('click', () => $('help').classList.remove('hidden'));
  $('btn-tour').addEventListener('click', () => {
    $('help').classList.add('hidden');
    runTour();
  });
  $('btn-help-close').addEventListener('click', () => $('help').classList.add('hidden'));
  $('help').addEventListener('click', (e) => {
    if (e.target.id === 'help') $('help').classList.add('hidden');
  });

  $('btn-dir').addEventListener('click', () => {
    const v = engine.voices[selected];
    v.dir *= -1;
    $('btn-dir').style.color = v.dir < 0 ? 'var(--accent)' : '';
  });

  $('btn-load').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (e) => {
    if (e.target.files[0]) await loadFileToPad(e.target.files[0], selected);
    e.target.value = '';
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input,select,textarea')) return;
    if (e.code === 'ArrowLeft') { e.preventDefault(); stepTab(-1); return; }
    if (e.code === 'ArrowRight') { e.preventDefault(); stepTab(1); return; }
    if (e.code === 'Escape') { e.preventDefault(); stopAll(); return; }
    // Cmd+Space belongs to Spotlight on a Mac and never reaches the page, so
    // capture lives on C, with Shift+Space as the space-adjacent alternative.
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); captureNow(); return; }
    if (e.code === 'Space' && e.shiftKey) { e.preventDefault(); captureNow(); return; }
    if (e.code === 'Space') { e.preventDefault(); toggleRecord(); return; }
    if (e.key === '?') { $('help').classList.toggle('hidden'); return; }

    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= PAD_COUNT) { togglePad(n - 1); select(n - 1); return; }

    const semi = QWERTY[e.key];
    if (semi !== undefined && !e.repeat) {
      qwertyHeld.add(semi);
      applyHeldNotes();
    }
  });

  window.addEventListener('keyup', (e) => {
    const semi = QWERTY[e.key];
    if (semi !== undefined && qwertyHeld.delete(semi)) applyHeldNotes();
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

/* ---------------- boot ---------------- */

async function begin() {
  $('gate').classList.add('hidden');
  await engine.init();
  await engine.resume();

  engine.voices.forEach((v, i) => v.set('cycle', DEFAULT_CYCLES[i]));

  recorder = new Recorder(engine.ctx);
  await recorder.attach(engine.limiter);
  input = new InputCapture(engine.ctx);
  broadcast = new Broadcast(engine, pads);
  broadcast.start();
  worldClock = new WorldClock(paintWorldClock);
  swells = new Swells(engine, pads, norm, denorm);
  effects = new Effects(engine, pads);

  morpher = new Morpher(engine, pads, applySpace, (p) => {
    morphProgress = p;
    broadcast.setScene(activeScene, morphTarget, p);
    if (p >= 1) {
      if (morphTarget !== null) markActiveScene(morphTarget);
      morphTarget = null;
      renderPadHeads();
      refreshPadPanel();
    }
    paintSlots();
  });

  buildPads();
  buildParams();
  wirePalette();
  wireCols();
  wireTransport();
  wireSize();
  wireFilterType();
  wirePlayMode();
  wireKnobMode();
  buildSlots();
  wireTabs();
  wireForge();
  wireInput();
  wireLive();
  wireStretch();
  wireSpace();
  wireScenes();
  wireFreesound();
  wireMidi();

  assignBuffer(0, generateSeed(engine.ctx, 'drone', { root: 220, character: 0.7 }), 'Drone A',
    { kind: 'forge', gen: 'drone', root: 220, character: 0.7, seconds: 10 });
  assignBuffer(1, generateSeed(engine.ctx, 'air', { character: 0.4 }), 'Air',
    { kind: 'forge', gen: 'air', root: 220, character: 0.4, seconds: 10 });
  assignBuffer(2, generateSeed(engine.ctx, 'bells', { root: 220, character: 0.4 }), 'Bells A',
    { kind: 'forge', gen: 'bells', root: 220, character: 0.4, seconds: 10 });
  engine.voices[1].set('level', 0.35);
  engine.voices[2].set('density', 4);
  engine.voices[2].set('grain', 420);

  selected = 0;
  refreshPadPanel();
  renderPadHeads();
  togglePad(0);
  frame();
  // Morphs run off a timer rather than the animation frame, so switching
  // windows mid-set cannot strand a glide halfway.
  let lastSwellAt = 0;
  setInterval(() => {
    try {
      morpher.tick();
      const t = engine.ctx.currentTime;
      const dt = lastSwellAt ? t - lastSwellAt : 0.033;
      lastSwellAt = t;
      if (swells.tick(dt)) buildParams();
      checkSceneEdited();
    } catch (err) { console.error('morph', err); }
  }, 33);

  window.__ambient = { engine, pads, recorder, input, midi, slots, morpher };

  // First time through, walk them round it. The keyboard shortcuts are a
  // shortcut — nobody should have to discover them to get a sound out.
  if (shouldRun()) setTimeout(() => runTour(), 700);
}

$('btn-begin').addEventListener('click', begin, { once: true });
wireGlobal();
