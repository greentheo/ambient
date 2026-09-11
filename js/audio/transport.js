// A clock, for when the music should not be ambient.
//
// BPM and a bar length in beats — no time signatures, no grid, no timeline.
// It exists so that pads which *want* to agree on where "now" is can, while
// everything else carries on drifting. Sync is opt-in per pad precisely
// because the polyrhythm has to stay the natural state.

const TICK_MS = 25;
const LOOKAHEAD = 0.12;

export class Transport {
  constructor(ctx, out) {
    this.ctx = ctx;
    this.bpm = 90;
    this.beatsPerBar = 4;
    this.running = false;
    this.startedAt = 0;
    this.metronome = false;

    this.click = ctx.createGain();
    this.click.gain.value = 0.35;
    this.click.connect(out);

    this.nextBeat = 0;
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  get secondsPerBeat() { return 60 / this.bpm; }
  get secondsPerBar() { return this.secondsPerBeat * this.beatsPerBar; }

  /** Fractional beats since start. */
  beats(now = this.ctx.currentTime) {
    if (!this.running) return 0;
    return (now - this.startedAt) / this.secondsPerBeat;
  }

  /** Fractional bars since start — what a synced pad reads. */
  bars(now = this.ctx.currentTime) {
    return this.beats(now) / this.beatsPerBar;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.ctx.currentTime + 0.05;
    this.nextBeat = this.startedAt;
  }

  stop() {
    this.running = false;
  }

  toggle() { this.running ? this.stop() : this.start(); }

  /** Changing tempo keeps the current bar position, so nothing lurches. */
  setBpm(bpm) {
    const at = this.ctx.currentTime;
    const beatsNow = this.beats(at);
    this.bpm = Math.max(20, Math.min(300, bpm));
    if (this.running) {
      this.startedAt = at - beatsNow * this.secondsPerBeat;
      this.nextBeat = Math.max(at, this.startedAt + Math.ceil(beatsNow) * this.secondsPerBeat);
    }
  }

  setBeatsPerBar(n) { this.beatsPerBar = Math.max(1, Math.min(16, Math.round(n))); }

  /** Audio time of the next downbeat at or after `from`. */
  nextDownbeat(from = this.ctx.currentTime) {
    if (!this.running) return from;
    const bars = this.bars(from);
    return this.startedAt + Math.ceil(bars - 1e-9) * this.secondsPerBar;
  }

  schedule() {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    if (this.nextBeat < now - 0.5) this.nextBeat = now;
    while (this.nextBeat < now + LOOKAHEAD) {
      const beatIndex = Math.round((this.nextBeat - this.startedAt) / this.secondsPerBeat);
      if (this.metronome) {
        this.tick(this.nextBeat, beatIndex % this.beatsPerBar === 0);
      }
      this.nextBeat += this.secondsPerBeat;
    }
  }

  /** A short wooden click; the downbeat is higher and louder. */
  tick(at, accent) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = accent ? 1600 : 1050;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(accent ? 0.9 : 0.45, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = accent ? 2200 : 1500;
    bp.Q.value = 1.2;
    osc.connect(g).connect(bp).connect(this.click);
    osc.start(at);
    osc.stop(at + 0.06);
    osc.onended = () => { osc.disconnect(); g.disconnect(); bp.disconnect(); };
  }

  setClickLevel(v) {
    this.click.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }
}
