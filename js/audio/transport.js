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
    // A count-in clicks whether or not the metronome is switched on, and
    // holds the audio time that recording is waiting for.
    this.countFrom = 0;
    this.countUntil = 0;
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
    this.cancelCount();
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

  /**
   * Arm a count-in of `bars` whole bars. Recording starts on the downbeat at
   * the end of it, so the take begins on the beat rather than wherever the
   * button happened to be pressed.
   *
   * The clicks sound whether or not the metronome is switched on — counting
   * silently is not counting.
   *
   * @returns {{at:number, from:number, beats:number}|null} null if no clock
   */
  countIn(bars = 1) {
    if (!this.running) return null;
    const from = this.nextDownbeat(this.ctx.currentTime + 0.08);
    const at = from + bars * this.secondsPerBar;
    this.countFrom = from;
    this.countUntil = at;
    return { at, from, beats: bars * this.beatsPerBar };
  }

  cancelCount() {
    this.countFrom = 0;
    this.countUntil = 0;
  }

  /**
   * Where the count-in has got to, for the display.
   * @returns {{beat:number, total:number, left:number}|null}
   */
  counting(now = this.ctx.currentTime) {
    if (!this.countUntil || now >= this.countUntil) return null;
    if (now < this.countFrom - 0.25) return null;
    const total = Math.round((this.countUntil - this.countFrom) / this.secondsPerBeat);
    const done = Math.floor(Math.max(0, now - this.countFrom) / this.secondsPerBeat);
    return { beat: Math.min(total, done + 1), total, left: this.countUntil - now };
  }

  schedule() {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    if (this.nextBeat < now - 0.5) this.nextBeat = now;
    while (this.nextBeat < now + LOOKAHEAD) {
      const beatIndex = Math.round((this.nextBeat - this.startedAt) / this.secondsPerBeat);
      // Count-in beats click regardless; the last one lands on the downbeat
      // that recording starts on, which is the one you play to.
      const counting = this.nextBeat >= this.countFrom - 1e-4
        && this.nextBeat < this.countUntil - 1e-4;
      if (this.metronome || counting) {
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
