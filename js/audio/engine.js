// Master signal path and the grain scheduler.
//
//   voices --> dry ------------------------\
//         \--> reverb send -> convolver ----+--> saturate -> master -> limiter -> out
//          \-> delay send  -> tape delay --/

import { makeIR } from './ir.js';
import { GranularVoice } from './granular.js';
import { Transport } from './transport.js';

const LOOKAHEAD = 0.12;   // seconds of grains scheduled ahead of the clock
const TICK_MS = 25;

function tanhCurve(amount = 2.2) {
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return c;
}

export class Engine {
  constructor(voiceCount = 8) {
    this.voiceCount = voiceCount;
    this.ctx = null;
    this.voices = [];
    this.timer = null;
  }

  async init() {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.ctx = ctx;

    this.out = ctx.createGain();
    this.out.gain.value = 0.8;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.25;

    this.saturator = ctx.createWaveShaper();
    this.saturator.curve = tanhCurve(1.6);
    this.saturator.oversample = '2x';

    this.sum = ctx.createGain();
    this.sum.gain.value = 0.9;

    // --- reverb -------------------------------------------------------
    this.reverbBus = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = makeIR(ctx, 7, 2.6, 0.62);
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 1;
    // Rolling off the bass keeps a long tail from turning to mud.
    this.reverbHP = ctx.createBiquadFilter();
    this.reverbHP.type = 'highpass';
    this.reverbHP.frequency.value = 160;
    this.reverbBus.connect(this.reverbHP).connect(this.convolver)
      .connect(this.reverbReturn).connect(this.sum);

    // --- tape delay ---------------------------------------------------
    this.delayBus = ctx.createGain();
    this.delay = ctx.createDelay(6);
    this.delay.delayTime.value = 2.4;
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.55;
    this.delayTone = ctx.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayTone.frequency.value = 2200;
    this.delayReturn = ctx.createGain();

    this.delayBus.connect(this.delay);
    this.delay.connect(this.delayTone).connect(this.feedback).connect(this.delay);
    this.delay.connect(this.delayReturn).connect(this.sum);

    // Slow wobble on the delay time, so repeats smear like tape.
    this.wow = ctx.createOscillator();
    this.wow.frequency.value = 0.09;
    this.wowDepth = ctx.createGain();
    this.wowDepth.gain.value = 0.004;
    this.wow.connect(this.wowDepth).connect(this.delay.delayTime);
    this.wow.start();

    this.dryBus = ctx.createGain();
    this.dryBus.connect(this.sum);

    this.sum.connect(this.saturator).connect(this.out)
      .connect(this.limiter).connect(ctx.destination);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.limiter.connect(this.analyser);

    // The metronome goes straight to the limiter, so it is audible to you but
    // sits outside the reverb and delay you are performing with.
    this.transport = new Transport(ctx, this.limiter);

    const buses = { dry: this.dryBus, reverb: this.reverbBus, delay: this.delayBus };
    for (let i = 0; i < this.voiceCount; i++) {
      this.voices.push(new GranularVoice(ctx, buses));
    }

    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  schedule() {
    const now = this.ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    for (const v of this.voices) v.tick(now, horizon, this.transport);
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
  }

  setReverb({ size, darkness, decay }) {
    this.convolver.buffer = makeIR(this.ctx, size, decay, darkness);
  }

  setMaster(v) {
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setDelay({ time, feedback, tone }) {
    const now = this.ctx.currentTime;
    if (time != null) this.delay.delayTime.setTargetAtTime(time, now, 0.4);
    if (feedback != null) this.feedback.gain.setTargetAtTime(feedback, now, 0.1);
    if (tone != null) this.delayTone.frequency.setTargetAtTime(tone, now, 0.1);
  }

  /**
   * Kill everything audible right now, tails included — the delay line can
   * ring for the best part of a minute on high feedback, so silencing the
   * voices alone is not enough. Restores the bus afterwards so the
   * instrument is immediately playable again.
   */
  panic(restoreAfter = 1.2) {
    const now = this.ctx.currentTime;
    const out = this.out.gain.value;
    const fb = this.feedback.gain.value;

    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0, now + 0.03);
    this.feedback.gain.cancelScheduledValues(now);
    this.feedback.gain.setValueAtTime(0, now);

    this.out.gain.setValueAtTime(0, now + restoreAfter);
    this.out.gain.linearRampToValueAtTime(out, now + restoreAfter + 0.05);
    this.feedback.gain.setValueAtTime(fb, now + restoreAfter);
  }

  /** Peak level of the master output, 0..1, for the meter. */
  level() {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const m = Math.abs(buf[i]);
      if (m > peak) peak = m;
    }
    return peak;
  }

  grainCount() {
    return this.voices.reduce((n, v) => n + v.grainCount, 0);
  }
}
