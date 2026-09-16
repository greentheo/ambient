// Taps the master bus and ships raw stereo PCM to the main thread.
// Buffered into blocks so we aren't posting a message every 128 frames.

const BLOCK = 4096;

class TapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.l = new Float32Array(BLOCK);
    this.r = new Float32Array(BLOCK);
    this.n = 0;
    // Frame the take is allowed to begin on. A count-in arms the node now and
    // names a moment in the future, which is the only way to start on the
    // beat — a setTimeout on the main thread is tens of milliseconds adrift.
    this.startFrame = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === 'stop' || (d && d.cmd === 'stop')) { this.flush(); this.recording = false; return; }
      if (d === 'start') { this.n = 0; this.startFrame = 0; this.recording = true; return; }
      if (d && d.cmd === 'start') {
        this.n = 0;
        this.startFrame = Math.max(0, Math.round(currentFrame + (d.at - currentTime) * sampleRate));
        this.recording = true;
      }
    };
  }

  flush() {
    if (this.n === 0) return;
    const l = this.l.slice(0, this.n);
    const r = this.r.slice(0, this.n);
    this.port.postMessage({ l, r }, [l.buffer, r.buffer]);
    this.n = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (input && input.length) {
      const cl = input[0];
      const cr = input.length > 1 ? input[1] : input[0];
      // Pass through, so the node stays pulled by the graph.
      if (output && output.length) {
        output[0].set(cl);
        if (output.length > 1) output[1].set(cr);
      }
      if (this.recording) {
        const base = currentFrame;
        const from = Math.max(0, this.startFrame - base);
        for (let i = from; i < cl.length; i++) {
          this.l[this.n] = cl[i];
          this.r[this.n] = cr[i];
          this.n++;
          if (this.n === BLOCK) this.flush();
        }
      }
    }
    return true;
  }
}

registerProcessor('tap-processor', TapProcessor);
