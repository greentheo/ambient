// A rolling window of live input that a granular voice can read from
// continuously. Play a note and it is already inside the cloud — no capture
// step, no waiting. Freeze locks the window so you can keep working the last
// few seconds after the sound itself has stopped.

const REFRESH_MS = 150;
const FADE_SEC = 0.02;

export class LiveBuffer {
  constructor(ctx, seconds = 8) {
    this.ctx = ctx;
    this.rate = ctx.sampleRate;
    this.frozen = false;
    this.node = null;
    this.timer = null;
    this.listeners = [];
    this.setWindow(seconds);
  }

  setWindow(seconds) {
    const n = Math.max(1, Math.floor(seconds * this.rate));
    this.seconds = seconds;
    this.ring = new Float32Array(n);
    this.write = 0;
    this.filled = 0;
    // Two sets of buffers, alternated. Grains in flight always read the set
    // we are not currently writing into, so a swap can never tear.
    this.sets = [0, 1].map(() => ({
      fwd: this.ctx.createBuffer(1, n, this.rate),
      rev: this.ctx.createBuffer(1, n, this.rate),
    }));
    this.active = 0;
  }

  onSwap(fn) { this.listeners.push(fn); }

  async attach(sourceNode) {
    await this.ctx.audioWorklet.addModule('js/audio/recorder-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'tap-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    this.node.port.onmessage = (e) => this.ingest(e.data.l);
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    sourceNode.connect(this.node);
    this.node.connect(sink).connect(this.ctx.destination);
    this.node.port.postMessage('start');

    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
    this.refresh();
  }

  detach() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.node) {
      this.node.port.postMessage('stop');
      this.node.disconnect();
      this.node = null;
    }
  }

  ingest(chunk) {
    const ring = this.ring;
    const n = ring.length;
    for (let i = 0; i < chunk.length; i++) {
      ring[this.write] = chunk[i];
      this.write = (this.write + 1) % n;
    }
    this.filled = Math.min(n, this.filled + chunk.length);
  }

  /** Unroll the ring into the inactive buffer set, then swap to it. */
  refresh() {
    if (this.frozen) return;
    const n = this.ring.length;
    const back = this.sets[1 - this.active];
    const fwd = back.fwd.getChannelData(0);
    const rev = back.rev.getChannelData(0);

    // Oldest sample first, so the window reads forward in time.
    const start = this.write;
    for (let i = 0; i < n; i++) fwd[i] = this.ring[(start + i) % n];

    // Grains wrap around the window edges, so taper both ends.
    const fade = Math.min(Math.floor(this.rate * FADE_SEC), (n / 4) | 0);
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      fwd[i] *= g;
      fwd[n - 1 - i] *= g;
    }
    for (let i = 0; i < n; i++) rev[i] = fwd[n - 1 - i];

    this.active = 1 - this.active;
    for (const fn of this.listeners) fn(back.fwd, back.rev);
  }

  setFrozen(on) {
    this.frozen = on;
    if (!on) this.refresh();
  }

  /** Copy the current window out as a standalone buffer, to keep on a pad. */
  snapshot() {
    const src = this.sets[this.active].fwd.getChannelData(0);
    const out = this.ctx.createBuffer(1, src.length, this.rate);
    out.getChannelData(0).set(src);
    return out;
  }
}
