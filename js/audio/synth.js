// Oscillators, for playing a pad from the keyboard instead of from a sample.
//
// This is deliberately small. It lands on the same node the grains do, so
// everything downstream shapes it exactly the way it shapes a recording —
// Tone and Sweep filter it, Width places it, Verb and Delay send it, Level
// and the pad's own fade carry it in and out. Fade in / Fade out double as
// the per-note envelope, so 0.02s is a pluck and 4s is a swell with no extra
// knobs to learn.
//
// What it replaces is only the source: notes, rather than a buffer.
//
// Notes arrive from two places — your hands, and a recorded sequence looping
// on the pad's own clock — and they are kept apart, so playing over a loop
// adds to it instead of cutting it off.

export const WAVES = [
  { id: 'sine',     name: 'Sine' },
  { id: 'triangle', name: 'Triangle' },
  { id: 'square',   name: 'Square' },
  { id: 'sawtooth', name: 'Saw' },
];

const MAX_VOICES = 16;   // enough for two hands over a loop; oldest goes first
const UNISON = 2;        // oscillators per note, detuned against each other

export class NoteSynth {
  constructor(ctx, out) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(out);

    this.wave = 'sine';
    // Keyed `${source}:${note}`, so the same pitch can come from your hands
    // and from the loop at once without one ending the other.
    this.voices = new Map();
    this.heldLive = new Set();
    this.rec = null;              // an in-progress sequence recording
    this.maxVoices = MAX_VOICES;

    // Shaped by the pad, pushed in whenever those parameters move.
    this.attack = 0.4;
    this.release = 1.5;
    this.detune = 0.15;
    this.spread = 0.8;
    this.pitch = 0;
  }

  /** Notes actually sounding, tails excluded — this is a display figure. */
  get count() {
    let n = 0;
    for (const v of this.voices.values()) if (!v.releasing) n++;
    return n;
  }

  setWave(wave) {
    this.wave = wave;
    for (const v of this.voices.values()) {
      for (const o of v.oscs) o.type = wave;
    }
  }

  /** Take the shaping parameters from the pad that owns this synth. */
  setShape({ attack, release, detune, spread, pitch }) {
    if (Number.isFinite(attack)) this.attack = attack;
    if (Number.isFinite(release)) this.release = release;
    if (Number.isFinite(detune)) this.detune = detune;
    if (Number.isFinite(spread)) this.spread = spread;
    if (Number.isFinite(pitch)) this.pitch = pitch;
    this.retune();
  }

  /** Cents offset for unison voice `k`, including the pad's transpose. */
  cents(k) {
    const spreadCents = this.detune * 15;
    const off = UNISON === 1 ? 0 : (k / (UNISON - 1) - 0.5) * 2 * spreadCents;
    return this.pitch * 100 + off;
  }

  /** Held notes follow Pitch and Detune while they are still sounding. */
  retune() {
    const now = this.ctx.currentTime;
    for (const v of this.voices.values()) {
      v.oscs.forEach((o, k) => o.detune.setTargetAtTime(this.cents(k), now, 0.02));
      v.pans.forEach((p, k) => {
        const at = UNISON === 1 ? 0 : (k / (UNISON - 1) - 0.5) * 2;
        p.pan.setTargetAtTime(at * this.spread * 0.8, now, 0.05);
      });
    }
  }

  /**
   * @param {number} note   midi note number
   * @param {number} [vel]  0..1
   * @param {number} [at]   audio time to start on; 0 means now. A looping
   *   sequence schedules ahead of the clock, the way grains do.
   * @param {'live'|'seq'} [src]
   */
  noteOn(note, vel = 0.8, at = 0, src = 'live') {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t = Math.max(now, at || now);
    const id = `${src}:${note}`;

    if (this.voices.has(id)) this.noteOff(note, true, t, src);
    if (this.voices.size >= this.maxVoices) {
      let oldest = null;
      for (const [k, v] of this.voices) if (!oldest || v.at < oldest[1].at) oldest = [k, v];
      if (oldest) this.kill(oldest[0]);
    }
    if (src === 'live' && this.rec) this.recOn(note, vel, t);

    const gain = ctx.createGain();
    const amp = 0.16 + vel * 0.34;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(amp, t + this.attack);
    gain.connect(this.out);

    const oscs = [], pans = [];
    for (let k = 0; k < UNISON; k++) {
      const osc = ctx.createOscillator();
      osc.type = this.wave;
      osc.frequency.value = 440 * Math.pow(2, (note - 69) / 12);
      osc.detune.value = this.cents(k);
      const pan = ctx.createStereoPanner();
      const spot = UNISON === 1 ? 0 : (k / (UNISON - 1) - 0.5) * 2;
      pan.pan.value = spot * this.spread * 0.8;
      osc.connect(pan).connect(gain);
      osc.start(t);
      oscs.push(osc);
      pans.push(pan);
    }
    this.voices.set(id, { oscs, pans, gain, at: t, releasing: false });
  }

  noteOff(note, immediate = false, at = 0, src = 'live') {
    const id = `${src}:${note}`;
    const v = this.voices.get(id);
    if (!v) return;
    const now = this.ctx.currentTime;
    // Never behind the clock, and never before the note actually started.
    const t = Math.max(now, at || now, v.at);
    const end = t + (immediate ? 0.012 : this.release);
    if (src === 'live' && this.rec) this.recOff(note, t);

    const g = v.gain.gain;
    // The fade-in may still be running at `t`, and its value there cannot be
    // read from here — hold whatever the envelope will have reached.
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else { g.cancelScheduledValues(t); g.setValueAtTime(Math.max(0.0001, g.value), t); }
    g.exponentialRampToValueAtTime(0.0001, end);
    for (const o of v.oscs) { try { o.stop(end + 0.02); } catch {} }

    // The slot stays occupied through the tail, so `count` tells the truth and
    // a retrigger during a long release still cuts the old note first.
    v.releasing = true;
    setTimeout(() => {
      if (this.voices.get(id) === v) this.voices.delete(id);
      for (const o of v.oscs) o.disconnect();
      for (const p of v.pans) p.disconnect();
      v.gain.disconnect();
    }, (end - now) * 1000 + 300);
  }

  /** Tear a voice down without a tail — used when stealing. */
  kill(id) {
    const v = this.voices.get(id);
    if (!v) return;
    this.voices.delete(id);
    const now = this.ctx.currentTime;
    const g = v.gain.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(now);
    else g.cancelScheduledValues(now);
    g.exponentialRampToValueAtTime(0.0001, now + 0.02);
    for (const o of v.oscs) { try { o.stop(now + 0.04); } catch {} }
    setTimeout(() => {
      for (const o of v.oscs) o.disconnect();
      for (const p of v.pans) p.disconnect();
      v.gain.disconnect();
    }, 400);
  }

  /**
   * Bring the *live* notes into line with a held set. Sequence notes are left
   * alone — playing over a loop has to add to it, not replace it.
   * @param {number[]} notes    midi note numbers
   * @param {Map<number,number>} [vel] velocities, 0..1
   */
  setHeld(notes, vel) {
    const want = new Set(notes);
    for (const n of [...this.heldLive]) {
      if (!want.has(n)) { this.heldLive.delete(n); this.noteOff(n); }
    }
    for (const n of want) {
      if (!this.heldLive.has(n)) {
        this.heldLive.add(n);
        this.noteOn(n, vel ? (vel.get(n) ?? 0.8) : 0.8);
      }
    }
  }

  allOff(immediate = false) {
    this.heldLive.clear();
    for (const id of [...this.voices.keys()]) {
      const [src, note] = id.split(':');
      this.noteOff(+note, immediate, 0, src);
    }
  }

  /* ---------------- recording a sequence ---------------- */

  /**
   * Collect what you play between `startAt` and `startAt + span`, as
   * fractions of the loop rather than seconds. Storing phase instead of time
   * is what lets Cycle stretch a recorded phrase the same way it stretches a
   * sample's read head.
   */
  armRecord(startAt, span) {
    this.rec = { startAt, span, events: [], open: new Map() };
  }

  recOn(note, vel, t) {
    const r = this.rec;
    if (t < r.startAt) return;                       // still counting in
    const at = (t - r.startAt) / r.span;
    if (at >= 1) return;                             // past the loop end
    const ev = { note, vel, at, dur: 0.02 };
    r.events.push(ev);
    r.open.set(note, ev);
  }

  recOff(note, t) {
    const r = this.rec;
    const ev = r.open.get(note);
    if (!ev) return;
    r.open.delete(note);
    const dur = (t - r.startAt) / r.span - ev.at;
    ev.dur = Math.max(0.005, Math.min(1 - ev.at, dur));
  }

  /** @returns {Array} the events, in order. Notes still down run to the end. */
  finishRecord() {
    const r = this.rec;
    this.rec = null;
    if (!r) return [];
    for (const ev of r.open.values()) ev.dur = Math.max(0.005, 1 - ev.at);
    return r.events.sort((a, b) => a.at - b.at);
  }
}

/**
 * Render a sequence to an AudioBuffer — the phrase becomes an ordinary
 * sample, and everything a sample gets is suddenly available to it: grains,
 * Texture, Spray, Stretch, the lot. The filter and the sends are *not*
 * baked in; those stay live on the pad, so bouncing costs you nothing you
 * were already doing.
 *
 * The release tail is wrapped back onto the head rather than extending the
 * buffer, so the result is exactly one pass long and loops without a seam.
 *
 * @param {AudioContext} ctx  only for its sample rate and buffer factory
 * @param {{events:Array, wave:string, shape:object, span:number}} opts
 * @returns {Promise<AudioBuffer>}
 */
export async function renderSequence(ctx, { events, wave, shape, span }) {
  const rate = ctx.sampleRate;
  const tail = Math.min(span, (shape.release || 1) + 0.3);
  const off = new OfflineAudioContext(2, Math.ceil((span + tail) * rate), rate);
  const sink = off.createGain();
  sink.connect(off.destination);

  const synth = new NoteSynth(off, sink);
  synth.maxVoices = Infinity;        // everything is scheduled up front
  synth.setWave(wave);
  synth.setShape(shape);
  // A source id per event, so two occurrences of the same pitch never read as
  // a retrigger and cut each other short.
  events.forEach((e, i) => {
    const at = e.at * span;
    synth.noteOn(e.note, e.vel, at, `r${i}`);
    synth.noteOff(e.note, false, at + e.dur * span, `r${i}`);
  });

  const rendered = await off.startRendering();
  const n = Math.round(span * rate);
  const out = ctx.createBuffer(2, n, rate);
  for (let ch = 0; ch < 2; ch++) {
    const src = rendered.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < n && i < src.length; i++) dst[i] = src[i];
    for (let i = n; i < src.length; i++) dst[i - n] += src[i];
  }
  return out;
}
