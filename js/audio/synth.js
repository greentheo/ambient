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

export const WAVES = [
  { id: 'sine',     name: 'Sine' },
  { id: 'triangle', name: 'Triangle' },
  { id: 'square',   name: 'Square' },
  { id: 'sawtooth', name: 'Saw' },
];

const MAX_VOICES = 12;   // enough for two hands; beyond that the oldest goes
const UNISON = 2;        // oscillators per note, detuned against each other

export class NoteSynth {
  constructor(ctx, out) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(out);

    this.wave = 'sine';
    this.voices = new Map();     // midi note -> { oscs, pans, gain, at }
    // Shaped by the pad, pushed in whenever those parameters move.
    this.attack = 0.4;
    this.release = 1.5;
    this.detune = 0.15;
    this.spread = 0.8;
    this.pitch = 0;
  }

  get count() { return this.voices.size; }

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

  noteOn(note, vel = 0.8) {
    if (this.voices.has(note)) this.noteOff(note, true);
    if (this.voices.size >= MAX_VOICES) {
      // Steal the oldest rather than silently dropping the new note.
      let oldest = null;
      for (const [n, v] of this.voices) if (!oldest || v.at < oldest[1].at) oldest = [n, v];
      if (oldest) this.noteOff(oldest[0], true);
    }

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    const amp = 0.16 + vel * 0.34;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(amp, now + this.attack);
    gain.connect(this.out);

    const oscs = [], pans = [];
    for (let k = 0; k < UNISON; k++) {
      const osc = ctx.createOscillator();
      osc.type = this.wave;
      osc.frequency.value = 440 * Math.pow(2, (note - 69) / 12);
      osc.detune.value = this.cents(k);
      const pan = ctx.createStereoPanner();
      const at = UNISON === 1 ? 0 : (k / (UNISON - 1) - 0.5) * 2;
      pan.pan.value = at * this.spread * 0.8;
      osc.connect(pan).connect(gain);
      osc.start(now);
      oscs.push(osc);
      pans.push(pan);
    }
    this.voices.set(note, { oscs, pans, gain, at: now });
  }

  noteOff(note, immediate = false) {
    const v = this.voices.get(note);
    if (!v) return;
    this.voices.delete(note);
    const now = this.ctx.currentTime;
    const fall = immediate ? 0.012 : this.release;
    const end = now + fall;
    const g = v.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.exponentialRampToValueAtTime(0.0001, end);
    for (const o of v.oscs) { try { o.stop(end + 0.02); } catch {} }
    setTimeout(() => {
      for (const o of v.oscs) o.disconnect();
      for (const p of v.pans) p.disconnect();
      v.gain.disconnect();
    }, fall * 1000 + 300);
  }

  /**
   * Bring the sounding notes into line with a held set. The rest of the app
   * already thinks in held sets rather than events, so this is the seam.
   * @param {number[]} notes    midi note numbers
   * @param {Map<number,number>} [vel] velocities, 0..1
   */
  setHeld(notes, vel) {
    const want = new Set(notes);
    for (const n of [...this.voices.keys()]) if (!want.has(n)) this.noteOff(n);
    for (const n of want) if (!this.voices.has(n)) this.noteOn(n, vel ? (vel.get(n) ?? 0.8) : 0.8);
  }

  allOff(immediate = false) {
    for (const n of [...this.voices.keys()]) this.noteOff(n, immediate);
  }
}
