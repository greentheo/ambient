// Live input: sing, play, hit something, and land it on a pad as raw
// material. Captured audio is just another buffer, so everything the
// granular engine does to a downloaded sample it does to your voice.

export class InputCapture {
  constructor(ctx) {
    this.ctx = ctx;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.monitorGain = null;
    this.busy = false;
  }

  get enabled() { return !!this.stream; }

  async enable(monitorBus) {
    if (this.stream) return;
    // Every bit of "helpful" processing has to go — it is built to destroy
    // exactly the sustained tones we want.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.source = this.ctx.createMediaStreamSource(this.stream);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);

    // Monitoring is off by default — through speakers it is a feedback loop.
    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.source.connect(this.monitorGain);
    if (monitorBus) this.monitorGain.connect(monitorBus);

    await this.ctx.audioWorklet.addModule('js/audio/recorder-worklet.js');
  }

  setMonitor(on) {
    if (!this.monitorGain) return;
    this.monitorGain.gain.setTargetAtTime(on ? 0.6 : 0, this.ctx.currentTime, 0.05);
  }

  /** Input peak, 0..1, for the level meter. */
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

  /**
   * Record `seconds` of input into an AudioBuffer.
   * @param {(t:number)=>void} [onProgress] called with elapsed seconds
   * @param {{startAt?:number, fade?:number}} [opts]
   *   startAt  audio time to begin on — the worklet holds until then, so a
   *            count-in lands the first sample exactly on the downbeat
   *   fade     edge fade in seconds; a bar-locked take wants this tiny, or
   *            the fade eats the downbeat transient it was recorded for
   * @returns {Promise<AudioBuffer>}
   */
  async capture(seconds, onProgress, opts = {}) {
    if (!this.stream) throw new Error('input not enabled');
    if (this.busy) throw new Error('already capturing');
    this.busy = true;

    const rate = this.ctx.sampleRate;
    const want = Math.round(seconds * rate);
    const node = new AudioWorkletNode(this.ctx, 'tap-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.source.connect(node);
    node.connect(sink).connect(this.ctx.destination);

    const chunks = [];
    let got = 0;

    const done = new Promise((resolve) => {
      node.port.onmessage = (e) => {
        chunks.push(e.data.l);
        got += e.data.l.length;
        if (onProgress) onProgress(got / rate);
        if (got >= want) resolve();
      };
    });

    if (opts.startAt) node.port.postMessage({ cmd: 'start', at: opts.startAt });
    else node.port.postMessage('start');
    await done;
    node.port.postMessage('stop');
    // Let the final flush arrive before we tear the node down.
    await new Promise((r) => setTimeout(r, 80));
    this.source.disconnect(node);
    node.disconnect();
    this.busy = false;

    const total = Math.min(want, got);
    const buf = this.ctx.createBuffer(2, total, rate);
    const l = buf.getChannelData(0);
    let off = 0;
    for (const c of chunks) {
      for (let i = 0; i < c.length && off < total; i++) l[off++] = c[i];
    }

    // Grains wrap around the ends of the buffer, so fade the edges or every
    // pass through the loop point clicks. Long enough to be inaudible, short
    // enough not to swallow whatever you played on the one.
    const fadeSecs = opts.fade ?? 0.05;
    const fade = Math.min(Math.floor(rate * fadeSecs), Math.floor(total / 4));
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      l[i] *= g;
      l[total - 1 - i] *= g;
    }
    buf.getChannelData(1).set(l);
    return buf;
  }
}
