// A granular voice: one sound source, sprayed into overlapping grains.
// This is the whole instrument, really — everything else is routing.

import { reverseBuffer } from './sources.js';
import { NoteSynth } from './synth.js';

// A Hann window, shared by every grain. setValueCurveAtTime copies the array,
// so one instance is safe to reuse.
const HANN = (() => {
  const n = 128;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return c;
})();

export const PARAMS = {
  level:    { min: 0,    max: 1,     def: 0.7,   step: 0.01, label: 'Level' },
  position: { min: 0,    max: 1,     def: 0,     step: 0.001, label: 'Pos' },
  cycle:    { min: 2,    max: 180,   def: 11,    step: 0.1,  label: 'Cycle', unit: 's', curve: 'log' },
  spray:    { min: 0,    max: 1,     def: 0.06,  step: 0.005, label: 'Spray' },
  grain:    { min: 20,   max: 800,   def: 180,   step: 1,    label: 'Grain', unit: 'ms' },
  density:  { min: 0.5,  max: 60,    def: 12,    step: 0.1,  label: 'Dens', unit: '/s' },
  pitch:    { min: -24,  max: 24,    def: 0,     step: 0.1,  label: 'Pitch', unit: 'st' },
  detune:   { min: 0,    max: 12,    def: 0.15,  step: 0.01, label: 'Detune' },
  reverse:  { min: 0,    max: 1,     def: 0.25,  step: 0.01, label: 'Rev' },
  // 0 is the sample as recorded, 1 is pure grains, and everything between is
  // both at once. A drum loop with a little texture on top is the whole point
  // — straight is a starting position, not a separate instrument.
  texture:  { min: 0,    max: 1,     def: 1,     step: 0.01, label: 'Texture' },
  attack:   { min: 0.02, max: 12,    def: 1.2,   step: 0.02, label: 'Fade in', unit: 's', curve: 'log' },
  release:  { min: 0.02, max: 20,    def: 3.0,   step: 0.02, label: 'Fade out', unit: 's', curve: 'log' },
  spread:   { min: 0,    max: 1,     def: 0.8,   step: 0.01, label: 'Width' },
  cutoff:   { min: 80,   max: 18000, def: 2400,  step: 10,   label: 'Tone', unit: 'Hz', curve: 'log' },
  sweep:    { min: 0,    max: 4800,  def: 1200,  step: 10,   label: 'Sweep', unit: 'c' },
  rate:     { min: 0.01, max: 4,     def: 0.07,  step: 0.005, label: 'Rate', unit: 'Hz', curve: 'log' },
  reverbSend: { min: 0,  max: 1,     def: 0.45,  step: 0.01, label: 'Verb' },
  delaySend:  { min: 0,  max: 1,     def: 0.2,   step: 0.01, label: 'Delay' },
};

export class GranularVoice {
  constructor(ctx, buses) {
    this.ctx = ctx;
    this.buffer = null;
    this.reversed = null;
    this.playing = false;
    this.dir = 1;          // read head direction; flipped from the pad UI
    // Held notes, in semitones from the source's own pitch. Grains spread
    // themselves across whatever is held, so one voice plays a whole chord.
    this.notes = [];
    this.live = false;     // reading a rolling live-input buffer
    // A pad can drop the buffer entirely and be played from the keyboard
    // instead. Same filter, same sends, same fades — only the source changes.
    this.keys = false;
    this.synth = null;
    this.filterType = 'lowpass';
    // 0 = free-running on its own Cycle. Anything else locks the read head to
    // that many bars of the transport, so this pad agrees with the beat while
    // the others carry on drifting.
    this.syncBars = 0;
    // Grains keep being scheduled until this time, so a fade-out is actually
    // heard rather than fading silence that already stopped.
    this.releaseUntil = 0;
    this.nextGrain = 0;
    this.lastTick = 0;
    this.grainCount = 0;

    this.p = {};
    for (const [k, spec] of Object.entries(PARAMS)) this.p[k] = spec.def;

    this.input = ctx.createGain();
    this.input.gain.value = 0;

    // The two ways of hearing the source, crossfaded by `texture`. Both feed
    // the same filter and sends, so a blend is one sound rather than two.
    this.loopGain = ctx.createGain();
    this.grainGain = ctx.createGain();
    this.loopGain.gain.value = 0;
    this.grainGain.gain.value = 1;
    this.loopGain.connect(this.input);
    this.grainGain.connect(this.input);

    // Two poles in series — 24dB/oct. A single lowpass barely bites on
    // material this broad, which is why Tone felt like it did nothing.
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = this.p.cutoff;
    this.filter.Q.value = 0.9;

    this.filter2 = ctx.createBiquadFilter();
    this.filter2.type = 'lowpass';
    this.filter2.frequency.value = this.p.cutoff;
    this.filter2.Q.value = 0.5;

    // A free-running LFO sweeps the cutoff. It drives `detune` rather than
    // `frequency`, so the sweep is exponential — equal musical distance up
    // and down — instead of lopsided towards the top of the range.
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = this.p.rate;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = this.p.sweep;
    this.lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.filter.detune);
    this.lfoDepth.connect(this.filter2.detune);
    this.lfo.start();

    this.dry = ctx.createGain();
    this.rev = ctx.createGain();
    this.del = ctx.createGain();
    this.rev.gain.value = this.p.reverbSend;
    this.del.gain.value = this.p.delaySend;

    this.input.connect(this.filter);
    this.filter.connect(this.filter2);
    this.filter2.connect(this.dry);
    this.filter2.connect(this.rev);
    this.filter2.connect(this.del);
    this.dry.connect(buses.dry);
    this.rev.connect(buses.reverb);
    this.del.connect(buses.delay);
  }

  setBuffer(buf) {
    this.live = false;
    this.clearNoteSource();
    this.buffer = buf;
    this.reversed = reverseBuffer(this.ctx, buf);
    if (this.loop) { this.stopLoop(); if (this.playing) this.startLoop(); }
  }

  /**
   * Point the voice at a live rolling buffer pair. Both are swapped wholesale
   * on each refresh, so there is no per-grain cost and no reversal to redo.
   */
  setLiveSource(forward, backward) {
    this.live = true;
    this.buffer = forward;
    this.reversed = backward;
  }

  setNotes(semitones) {
    this.notes = semitones;
  }

  /**
   * Swap the sample out for oscillators. The voice keeps every parameter it
   * had; the ones that describe how to read a buffer simply have nothing to
   * read, which is why the UI greys them out.
   */
  setNoteSource(wave = 'sine') {
    this.live = false;
    this.keys = true;
    this.buffer = null;
    this.reversed = null;
    this.notes = [];
    this.stopLoop();
    if (!this.synth) this.synth = new NoteSynth(this.ctx, this.input);
    this.synth.setWave(wave);
    this.pushShape();
  }

  clearNoteSource() {
    if (!this.keys) return;
    this.keys = false;
    if (this.synth) this.synth.allOff(true);
  }

  /** Hand the synth the parameters it shares with the granular layer. */
  pushShape() {
    if (!this.synth) return;
    this.synth.setShape({
      attack: this.p.attack, release: this.p.release,
      detune: this.p.detune, spread: this.p.spread, pitch: this.p.pitch,
    });
  }

  /** Equal power, so a blend does not dip in the middle. */
  applyTexture() {
    const t = this.p.texture;
    const now = this.ctx.currentTime;
    this.grainGain.gain.setTargetAtTime(Math.sin(t * Math.PI / 2), now, 0.04);
    this.loopGain.gain.setTargetAtTime(Math.cos(t * Math.PI / 2), now, 0.04);
    // The loop only runs when it can be heard.
    if (t < 0.999 && this.playing && !this.loop) this.startLoop();
    else if (t >= 0.999 && this.loop) this.stopLoop();
  }

  /**
   * How long one pass through the sample takes — the same number that governs
   * the granular read head. Bars win when the pad is locked to the clock.
   */
  span(transport) {
    if (this.syncBars > 0 && transport && transport.running) {
      return this.syncBars * transport.secondsPerBar;
    }
    return this.p.cycle;
  }

  /**
   * The straight layer plays at whatever speed makes one pass take `span`, so
   * it travels the sample at the same rate the grains do. One clock for the
   * pad rather than two that swap over at some threshold.
   */
  loopRate(transport) {
    if (!this.buffer) return 1;
    const want = this.span(transport);
    const base = want > 0 ? this.buffer.duration / want : 1;
    return Math.max(0.03, Math.min(16, base * Math.pow(2, this.p.pitch / 12)));
  }

  startLoop(at, transport) {
    if (!this.buffer || this.loop) return;
    const when = at ?? this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.playbackRate.value = this.loopRate(transport);
    src.connect(this.loopGain);
    src.start(when);
    this.loop = src;
    this.loopAt = when;
    // Start the read head with it, so the marker and the sound agree.
    this.p.position = 0;
  }

  stopLoop() {
    if (!this.loop) return;
    try { this.loop.stop(this.ctx.currentTime + 0.02); } catch {}
    const dead = this.loop;
    setTimeout(() => dead.disconnect(), 300);
    this.loop = null;
  }

  /**
   * Lowpass / bandpass / highpass. Bandpass is the one that makes a sweep
   * obvious on narrow material — it takes the fundamental out as it travels,
   * where a lowpass sitting above everything simply has nothing to remove.
   */
  setFilterType(type) {
    this.filterType = type;
    this.filter.type = type;
    this.filter2.type = type;
    // Set directly — nothing modulates Q, and a scheduled ramp here only
    // makes the value harder to read back.
    const band = type === 'bandpass';
    this.filter.Q.value = band ? 3.5 : 0.9;
    this.filter2.Q.value = band ? 2.0 : 0.5;
  }

  set(name, value) {
    const spec = PARAMS[name];
    if (!spec) return;
    // A non-finite value poisons everything downstream — the parameter, the
    // display, and any AudioParam it is written to. Reject it at the door.
    if (!Number.isFinite(value)) return;
    const v = Math.min(spec.max, Math.max(spec.min, value));
    this.p[name] = v;
    const now = this.ctx.currentTime;
    // Smooth the params that would click or zipper if set abruptly.
    if (name === 'cutoff') {
      this.filter.frequency.setTargetAtTime(v, now, 0.02);
      this.filter2.frequency.setTargetAtTime(v, now, 0.02);
    } else if (name === 'sweep') this.lfoDepth.gain.setTargetAtTime(v, now, 0.05);
    else if (name === 'rate') this.lfo.frequency.setTargetAtTime(v, now, 0.05);
    else if (name === 'texture') this.applyTexture();
    else if (name === 'reverbSend') this.rev.gain.setTargetAtTime(v, now, 0.03);
    else if (name === 'delaySend') this.del.gain.setTargetAtTime(v, now, 0.03);
    else if (this.keys && (name === 'attack' || name === 'release'
             || name === 'detune' || name === 'spread' || name === 'pitch')) {
      this.pushShape();
    }
    if (name === 'level' && this.playing) {
      // Cancel the fade-in from start(), so a morph driving level is the
      // only thing steering the gain.
      this.input.gain.cancelScheduledValues(now);
      this.input.gain.setValueAtTime(this.input.gain.value, now);
      this.input.gain.setTargetAtTime(v, now, 0.05);
    }
  }

  start() {
    if (this.playing || (!this.buffer && !this.keys)) return;
    this.playing = true;
    this.releaseUntil = 0;
    if (this.p.texture < 0.999) this.startLoop();
    const now = this.ctx.currentTime;
    if (this.nextGrain < now) this.nextGrain = now + 0.05;
    this.lastTick = now;
    // Fade in slowly — this is not a drum machine.
    this.input.gain.cancelScheduledValues(now);
    this.input.gain.setValueAtTime(this.input.gain.value, now);
    this.input.gain.linearRampToValueAtTime(this.p.level, now + this.p.attack);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    const now = this.ctx.currentTime;
    // Grains carry on being scheduled for the whole fade. Without this the
    // cloud stops within one grain and the ramp fades nothing.
    this.releaseUntil = now + this.p.release;
    if (this.synth) this.synth.allOff();
    // Let the fade finish before the source goes.
    if (this.loop) {
      setTimeout(() => { if (!this.playing) this.stopLoop(); }, this.p.release * 1000 + 60);
    }
    this.input.gain.cancelScheduledValues(now);
    this.input.gain.setValueAtTime(this.input.gain.value, now);
    this.input.gain.linearRampToValueAtTime(0, this.releaseUntil);
  }

  /** Audible if playing, or still inside a fade-out. */
  get sounding() { return this.playing || this.ctx.currentTime < this.releaseUntil; }

  /**
   * Advance the read head and schedule any grains falling inside the horizon.
   * @param {number} now      ctx.currentTime
   * @param {number} horizon  schedule grains starting before this time
   */
  /** @param {import('./transport.js').Transport} [transport] */
  tick(now, horizon, transport) {
    const dt = Math.min(0.25, Math.max(0, now - this.lastTick));
    this.lastTick = now;
    if (!this.buffer) return;

    // Both layers travel at the same rate, so the read head below is right for
    // either of them and there is no handover anywhere in the blend.
    if (this.loop) {
      this.loop.playbackRate.setTargetAtTime(this.loopRate(transport), now, 0.05);
    }

    // A synced pad takes its position straight from the clock rather than
    // integrating its own, so it can never drift out of agreement.
    if (this.syncBars > 0 && transport && transport.running && !this.frozen) {
      const pos = (transport.bars(now) / this.syncBars) * this.dir;
      this.p.position = ((pos % 1) + 1) % 1;
      if (this.loop) this.loop.playbackRate.setTargetAtTime(this.loopRate(transport), now, 0.05);
      if (!this.sounding) return;
      if (this.p.texture > 0.001) this.scheduleWindow(now, horizon);
      return;
    }

    // The read head sweeps the whole source once every `cycle` seconds,
    // independent of how long the sample is. There is no shared clock: give
    // each pad a coprime-ish cycle (7.3 / 11.1 / 4.7) and they will drift
    // against each other for hours without ever realigning.
    if (this.p.cycle > 0 && !this.frozen) {
      let pos = this.p.position + (this.dir * dt) / this.p.cycle;
      pos = pos - Math.floor(pos);
      this.p.position = pos;
    }

    if (!this.sounding) return;
    // Nothing to schedule when the sound is playing entirely straight.
    if (this.p.texture > 0.001) this.scheduleWindow(now, horizon);
  }

  scheduleWindow(now, horizon) {
    if (this.nextGrain < now - 0.5) this.nextGrain = now; // recover from stalls

    let budget = 40; // hard cap per tick, so a huge density can't lock the page
    while (this.nextGrain < horizon && budget-- > 0) {
      this.scheduleGrain(this.nextGrain);
      const interval = 1 / this.p.density;
      this.nextGrain += interval * (0.65 + Math.random() * 0.7);
    }
  }

  scheduleGrain(t) {
    const p = this.p;
    const useRev = Math.random() < p.reverse;
    const buf = useRev ? this.reversed : this.buffer;
    if (!buf) return;

    // Each grain lands on one of the held notes, so a sustained chord comes
    // out as one cloud rather than as stacked separate voices.
    const chord = this.notes.length
      ? this.notes[(Math.random() * this.notes.length) | 0]
      : 0;
    const semis = p.pitch + chord + (Math.random() * 2 - 1) * p.detune;
    const rate = Math.pow(2, semis / 12);
    const durSec = p.grain / 1000;
    // A few ms of tail past the envelope, so the source never cuts before
    // the Hann window has closed.
    const consumed = durSec * rate;
    const span = consumed + rate * 0.005;
    const maxOffset = Math.max(0, buf.duration - span);
    if (maxOffset <= 0) return;

    let pos = p.position + (Math.random() * 2 - 1) * p.spray;
    pos = pos - Math.floor(pos);
    let offset = pos * buf.duration;
    // Mirror the offset for reversed grains so `position` still means the
    // same point in the source material.
    if (useRev) offset = buf.duration - offset - consumed;
    offset = Math.min(maxOffset, Math.max(0, offset));

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.setValueCurveAtTime(HANN, t, durSec);

    const pan = this.ctx.createStereoPanner();
    pan.pan.value = (Math.random() * 2 - 1) * p.spread;

    src.connect(g).connect(pan).connect(this.grainGain);
    // The duration argument bounds the grain on its own. Do not also call
    // stop() — a stop scheduled near the natural end makes Chrome fire
    // `ended` twice, and the teardown runs twice with it.
    src.start(t, offset, span);

    this.grainCount++;
    let done = false;
    src.onended = () => {
      if (done) return;
      done = true;
      this.grainCount--;
      src.disconnect();
      g.disconnect();
      pan.disconnect();
    };
  }
}
