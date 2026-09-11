// Session recorder. Captures the master bus as PCM and encodes a 16-bit
// stereo WAV on stop — a file you can hand straight to a mastering chain
// or an upload form.

export class Recorder {
  constructor(ctx) {
    this.ctx = ctx;
    this.node = null;
    this.chunks = [];
    this.frames = 0;
    this.recording = false;
    this.startedAt = 0;
  }

  async attach(sourceNode) {
    await this.ctx.audioWorklet.addModule('js/audio/recorder-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'tap-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (e) => {
      if (!this.recording) return;
      this.chunks.push(e.data);
      this.frames += e.data.l.length;
    };
    // The worklet must reach the destination to be pulled, but must not be
    // heard twice — so it lands in a silent sink.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    sourceNode.connect(this.node);
    this.node.connect(sink).connect(this.ctx.destination);
  }

  start() {
    if (this.recording || !this.node) return;
    this.chunks = [];
    this.frames = 0;
    this.recording = true;
    this.startedAt = this.ctx.currentTime;
    this.node.port.postMessage('start');
  }

  /** @returns {{blob: Blob, seconds: number}|null} */
  stop() {
    if (!this.recording) return null;
    this.node.port.postMessage('stop');
    this.recording = false;
    // The flush message is already queued behind us on the port; give it a
    // beat to land before we encode.
    return new Promise((resolve) => {
      setTimeout(() => {
        const blob = this.encodeWav();
        const seconds = this.frames / this.ctx.sampleRate;
        this.chunks = [];
        resolve({ blob, seconds });
      }, 120);
    });
  }

  elapsed() {
    return this.recording ? this.ctx.currentTime - this.startedAt : 0;
  }

  encodeWav() {
    const rate = this.ctx.sampleRate;
    const frames = this.chunks.reduce((n, c) => n + c.l.length, 0);
    const bytes = 44 + frames * 4; // 2 channels * 16 bit
    const view = new DataView(new ArrayBuffer(bytes));

    const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    view.setUint32(4, bytes - 8, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);          // PCM
    view.setUint16(22, 2, true);          // stereo
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 4, true);   // byte rate
    view.setUint16(32, 4, true);          // block align
    view.setUint16(34, 16, true);         // bits
    str(36, 'data');
    view.setUint32(40, frames * 4, true);

    let off = 44;
    for (const c of this.chunks) {
      for (let i = 0; i < c.l.length; i++) {
        const l = Math.max(-1, Math.min(1, c.l[i]));
        const r = Math.max(-1, Math.min(1, c.r[i]));
        view.setInt16(off, l < 0 ? l * 0x8000 : l * 0x7fff, true); off += 2;
        view.setInt16(off, r < 0 ? r * 0x8000 : r * 0x7fff, true); off += 2;
      }
    }
    return new Blob([view.buffer], { type: 'audio/wav' });
  }
}
