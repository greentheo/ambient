// Publishes the instrument's state for other tabs to draw. Same origin, no
// server: a BroadcastChannel reaches every tab and window of this app.
//
// Driven by a timer off the audio clock, never requestAnimationFrame. The
// moment the visualiser goes fullscreen on a second screen, this tab is
// backgrounded and rAF stops — exactly the failure that must not happen
// mid-performance.

export const CHANNEL = 'ambient-viz';
export const BACK_CHANNEL = 'ambient-world';
const RATE_MS = 33;

export class Broadcast {
  constructor(engine, pads) {
    this.engine = engine;
    this.pads = pads;
    this.channel = null;
    this.timer = null;
    this.scene = { active: null, target: null, progress: 0 };
  }

  get open() { return !!this.channel; }

  start() {
    if (this.channel) return;
    this.channel = new BroadcastChannel(CHANNEL);
    this.timer = setInterval(() => this.post(), RATE_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.channel) this.channel.close();
    this.channel = null;
  }

  /** Called by the app when a morph starts, advances or lands. */
  setScene(active, target, progress) {
    this.scene = { active, target, progress };
  }

  post() {
    if (!this.channel) return;
    const e = this.engine;
    const num = (id) => +document.getElementById(id).value;
    this.channel.postMessage({
      t: e.ctx.currentTime,
      master: e.level(),
      grains: e.grainCount(),
      scene: this.scene,
      space: { reverb: num('rv-size'), dark: num('rv-dark'), feedback: num('dl-fb') },
      voices: e.voices.map((v, i) => ({
        on: this.pads[i].on,
        level: v.p.level,
        position: v.p.position,
        cycle: v.p.cycle,
        cutoff: v.p.cutoff,
        density: v.p.density,
        grain: v.p.grain,
        notes: v.notes.length,
        band: v.filterType === 'bandpass',
      })),
    });
  }
}

/**
 * The other direction: what the world is doing, so a set can be played to the
 * light. Read-only on purpose — the world reports, it does not steer. Nothing
 * here touches a parameter you might have your hand on.
 */
export class WorldClock {
  constructor(onUpdate) {
    this.state = null;
    this.lastSeen = 0;
    this.channel = new BroadcastChannel(BACK_CHANNEL);
    this.channel.onmessage = (e) => {
      this.state = e.data;
      this.lastSeen = performance.now();
      if (onUpdate) onUpdate(this.state);
    };
  }

  get live() { return performance.now() - this.lastSeen < 2000; }
}
