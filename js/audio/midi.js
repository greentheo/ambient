// Web MIDI, shaped around the common little controller: 8 pads, 8 knobs and
// a two-octave keyboard.
//
//   pads     select a voice; hit the one already selected to switch it
//   knobs    drive eight parameters of whichever voice is selected
//   scenes   four keys that trigger a morph to scene A-D
//   launch   eight keys that start pads; play several as a chord and they
//            all come in together
//   macros   four keys that swell a parameter while held and let it sink
//            back when released
//   keys     anything else adds held notes to that voice's grain cloud
//
// Banks are the other shape. A bank maps eight controls to the eight tracks
// for ONE parameter — a row of knobs, or a row of faders — so a surface with
// rows can address every track at once without selecting anything first.
// Banks remember which device they came from, so the same CC number on two
// controllers does not collide.
//
// Pads and knobs are learned once by hitting or turning them in order, so it
// works with any controller without a table of vendor CC numbers. Anything
// on the keyboard that is not a learned pad counts as a note.

const STORE_KEY = 'ambient.midi.map';

// The eight you actually reach for mid-piece. Spray, Delay send and Pitch
// stay available in the cells below the knob row.
export const KNOB_TARGETS = [
  'level', 'cycle', 'grain', 'density', 'rate', 'cutoff', 'spray', 'sweep',
];

// Parameters a knob nudges rather than jumps to. Relative control needs no
// soft takeover at all — there is no value to catch up with — which suits
// anything centred, where parking a knob at an extreme is normal.
export const RELATIVE = new Set(['pitch']);

/** A macro entry is an object; every other mapping is a bare note number. */
export function noteOf(m) { return typeof m === 'object' && m ? m.note : m; }

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Human-readable form of a message, for the monitor line. */
function describe(status, channel, a, b) {
  const ch = `ch${channel + 1}`;
  if (status === 0xb0) return `CC ${a} = ${b}  (${ch})`;
  if (status === 0x90 && b > 0) return `note on ${NOTES[a % 12]}${Math.floor(a / 12) - 1} (${a}) vel ${b}  (${ch})`;
  if (status === 0x80 || status === 0x90) return `note off ${NOTES[a % 12]}${Math.floor(a / 12) - 1} (${a})  (${ch})`;
  if (status === 0xe0) return `pitch bend  (${ch})`;
  return `status 0x${status.toString(16)} ${a} ${b}  (${ch})`;
}

export class Midi {
  constructor(handlers) {
    this.h = handlers;
    this.access = null;
    this.learn = null;          // 'pads' | 'knobs' | null
    this.learnIndex = 0;
    this.inputName = '';
    this.inputs = [];
    this.lastMessage = null;    // for the monitor line
    this.messageCount = 0;
    // pads/scenes hold note numbers, knobs hold CC numbers
    this.map = { pads: [], knobs: [], scenes: [], launch: [], macros: [], banks: [], fx: [] };
    // Notes landing within this window count as one chord, so pads played
    // together come in together instead of one at a time.
    this.chordWindow = 60;
    this.pendingLaunch = [];
    this.launchTimer = null;
    this.held = new Set();
    // How hard each held note was struck, 0..1 — the note source plays with
    // it, the grain cloud ignores it.
    this.vel = new Map();
    // Absolute knobs jump when you change pads, so a knob stays inert until
    // it crosses the value it is about to take over.
    this.takeover = new Map();
    this.load();
  }

  get available() { return typeof navigator.requestMIDIAccess === 'function'; }

  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) this.map = { pads: [], knobs: [], scenes: [], launch: [], macros: [],
        banks: [], fx: [], ...JSON.parse(raw) };
    } catch { /* first run, or storage disabled */ }
  }

  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.map));
      return true;
    } catch { return false; }
  }

  clear() {
    this.map = { pads: [], knobs: [], scenes: [], launch: [], macros: [], banks: [], fx: [] };
    // Notes landing within this window count as one chord, so pads played
    // together come in together instead of one at a time.
    this.chordWindow = 60;
    this.pendingLaunch = [];
    this.launchTimer = null;
    try { localStorage.removeItem(STORE_KEY); } catch {}
  }

  /** How many of each control have been learned, for the UI. */
  counts() {
    return {
      pads: this.map.pads.length,
      knobs: this.map.knobs.length,
      scenes: this.map.scenes.length,
      launch: this.map.launch.length,
      macros: this.map.macros.length,
      banks: (this.map.banks || []).length,
      fx: (this.map.fx || []).length,
    };
  }

  /**
   * Reconnect without prompting, but only if MIDI access was already granted
   * in a previous session. The mapping is restored from storage on
   * construction, so without this the panel comes back looking fully
   * configured while nothing is actually bound to the device.
   * @returns {Promise<string|null>} the input names, or null if not granted
   */
  async autoEnable() {
    if (!this.available) return null;
    try {
      const status = await navigator.permissions.query({ name: 'midi', sysex: false });
      if (status.state !== 'granted') return null;
    } catch {
      // Browsers that cannot be asked get the manual button.
      return null;
    }
    return await this.enable();
  }

  async enable() {
    if (!this.available) throw new Error('Web MIDI is not supported in this browser');
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    const bind = () => {
      const names = [];
      for (const inp of this.access.inputs.values()) {
        // Which surface a message came from matters once there is more than
        // one: two controllers will happily use the same CC numbers.
        inp.onmidimessage = (e) => this.onMessage(e.data, inp.name);
        names.push(inp.name);
      }
      this.inputs = names;
      this.inputName = names.join(', ') || 'no inputs';
      if (this.h.onStatus) this.h.onStatus(this.inputName, names.length);
    };
    bind();
    // Devices that appear later — or are released by another app — get picked
    // up here, so plugging in after loading the page still works.
    this.access.onstatechange = bind;
    return { name: this.inputName, count: this.inputs.length };
  }

  startLearn(kind) {
    // Capture into a staging list. The existing mapping is only replaced once
    // a full set has actually been collected — a learn that receives nothing
    // (no device bound, wrong port) must not leave you with nothing either.
    this.learn = kind;
    this.learnIndex = 0;
    this.target = (kind === 'scenes' || kind === 'macros' || kind === 'fx') ? 4 : 8;
    this.pending = [];
    this.bankDevice = null;
    this.bankKind = null;
    if (this.h.onLearn) this.h.onLearn(kind, 0, this.target);
  }

  cancelLearn() {
    this.learn = null;
    this.pending = [];
    if (this.h.onLearn) this.h.onLearn(null, 0, 0);
  }

  /**
   * Learning a bank: touch eight controls in track order. The first one seen
   * fixes which device the bank belongs to.
   */
  learnBank(kind, id, device) {
    if (!this.pending.length) this.bankKind = kind;
    if (this.bankKind !== kind) return;             // don't mix knobs and pads
    if (this.pending.includes(id)) return;
    if (!this.bankDevice) this.bankDevice = device;
    else if (device && this.bankDevice !== device) return;

    this.pending.push(id);
    this.learnIndex = this.pending.length;
    if (this.h.onLearn) this.h.onLearn('bank', this.learnIndex, this.target);
    if (this.learnIndex >= this.target) {
      (this.map.banks = this.map.banks || []).push({
        kind, device: this.bankDevice, ids: this.pending.slice(),
        // Knobs land on a parameter, pads on a per-track action.
        param: kind === 'cc' ? 'level' : null,
        action: kind === 'note' ? 'toggle' : null,
        focus: true,
      });
      this.save();
      this.cancelLearn();
    }
  }

  removeBank(i) {
    this.map.banks.splice(i, 1);
    this.save();
  }

  /** Commit a completed staging list over the live mapping. */
  commitLearn(kind) {
    this.map[kind] = this.pending;
    this.save();
    this.cancelLearn();
  }

  onMessage(data, device = '') {
    const status = data[0] & 0xf0;
    const channel = data[0] & 0x0f;
    const a = data[1], b = data[2];

    this.messageCount++;
    this.lastDevice = device;
    this.lastMessage = describe(status, channel, a, b);
    if (this.h.onActivity) this.h.onActivity(this.lastMessage, this.messageCount, device);

    if (status === 0xb0) return this.onCC(a, b, device);
    if (status === 0x90 && b > 0) return this.onNoteOn(a, channel, device, b / 127);
    if (status === 0x80 || (status === 0x90 && b === 0)) return this.onNoteOff(a, device);
  }

  /** A bank slot matching this control, or null. */
  bankHit(kind, id, device) {
    for (const bank of this.map.banks || []) {
      if (bank.kind !== kind) continue;
      if (bank.device && device && bank.device !== device) continue;
      const track = bank.ids.indexOf(id);
      if (track >= 0) return { bank, track };
    }
    return null;
  }

  onCC(cc, value, device = '') {
    if (this.learn === 'bank') return this.learnBank('cc', cc, device);

    const hit = this.bankHit('cc', cc, device);
    if (hit) { this.h.onBank(hit.bank, hit.track, value / 127); return; }

    if (this.learn === 'knobs') {
      if (this.pending.includes(cc)) return;
      this.pending.push(cc);
      this.learnIndex = this.pending.length;
      if (this.h.onLearn) this.h.onLearn('knobs', this.learnIndex, this.target);
      if (this.learnIndex >= this.target) this.commitLearn('knobs');
      return;
    }
    const slot = this.map.knobs.indexOf(cc);
    if (slot < 0) return;
    this.h.onKnob(slot, value / 127);
  }

  onNoteOn(note, channel, device = '', velocity = 0.8) {
    if (this.learn === 'bank') return this.learnBank('note', note, device);

    const hit = this.bankHit('note', note, device);
    if (hit) { this.h.onBank(hit.bank, hit.track, 1); return; }

    if (this.learn === 'pads' || this.learn === 'scenes'
        || this.learn === 'launch' || this.learn === 'macros' || this.learn === 'fx') {
      if (this.pending.some((m) => noteOf(m) === note)) return;   // twice in one pass
      // If the control already has another job, take it — refusing silently
      // just looks like the controller is not working.
      const stolen = this.release(this.learn, note);
      this.pending.push(
        this.learn === 'macros' ? { note, param: 'density', amount: 0.45, scope: 'selected' }
        : this.learn === 'fx' ? { note, effect: 'freeze', scope: 'selected' }
        : note);
      this.learnIndex = this.pending.length;
      if (this.h.onLearn) this.h.onLearn(this.learn, this.learnIndex, this.target, stolen);
      if (this.learnIndex >= this.target) this.commitLearn(this.learn);
      return;
    }

    const pad = this.padFor(note, channel);
    if (pad >= 0) { this.h.onPad(pad); return; }

    const scene = this.map.scenes.indexOf(note);
    if (scene >= 0) { this.h.onScene(scene); return; }

    const launch = (this.map.launch || []).findIndex((m) => m != null && m === note);
    if (launch >= 0) { this.queueLaunch(launch); return; }

    const fx = (this.map.fx || []).findIndex((m) => noteOf(m) === note);
    if (fx >= 0) { this.h.onEffect(fx, true); return; }

    const macro = (this.map.macros || []).findIndex((m) => noteOf(m) === note);
    if (macro >= 0) { this.h.onMacro(macro, true); return; }

    this.held.add(note);
    this.vel.set(note, velocity);
    this.h.onNotes([...this.held]);
  }

  /** The mapping as a portable preset file. */
  toPreset() {
    return JSON.stringify({
      format: 'ambient-midi-map',
      version: 1,
      map: this.map,
    }, null, 2);
  }

  /** @param {string} text contents of a preset file */
  fromPreset(text) {
    const data = JSON.parse(text);
    if (data.format !== 'ambient-midi-map') throw new Error('not an Ambient MIDI preset');
    this.map = { pads: [], knobs: [], scenes: [], ...data.map };
    this.save();
    return this.counts();
  }

  /**
   * Take a note away from whatever else was using it.
   * @returns {string|null} the role it was taken from, for the status line
   */
  release(kind, note) {
    for (const k of ['pads', 'scenes', 'launch', 'macros', 'fx']) {
      if (k === kind) continue;
      const list = this.map[k] || [];
      const at = list.findIndex((m) => noteOf(m) === note);
      if (at < 0) continue;
      // Pads and launch are positional — blanking keeps the rest in place.
      if (k === 'pads' || k === 'launch') list[at] = null;
      else list.splice(at, 1);
      return k;
    }
    return null;
  }

  /** True once a device is bound AND at least one input was found. */
  get connected() { return !!this.access && this.inputs.length > 0; }

  onNoteOff(note, device = '') {
    const hit = this.bankHit('note', note, device);
    if (hit) { this.h.onBank(hit.bank, hit.track, 0); return; }

    const fx = (this.map.fx || []).findIndex((m) => noteOf(m) === note);
    if (fx >= 0) { this.h.onEffect(fx, false); return; }

    const macro = (this.map.macros || []).findIndex((m) => noteOf(m) === note);
    if (macro >= 0) { this.h.onMacro(macro, false); return; }
    if (this.held.delete(note)) { this.vel.delete(note); this.h.onNotes([...this.held]); }
  }

  /**
   * Collect launch keys pressed at roughly the same moment and act on them as
   * one gesture. Deciding once for the whole group is what stops a chord from
   * flipping some pads on and others off.
   */
  queueLaunch(index) {
    if (!this.pendingLaunch.includes(index)) this.pendingLaunch.push(index);
    if (this.launchTimer) return;
    this.launchTimer = setTimeout(() => {
      const group = this.pendingLaunch.slice();
      this.pendingLaunch = [];
      this.launchTimer = null;
      this.h.onLaunch(group);
    }, this.chordWindow);
  }

  /** Learned pads win; otherwise channel 10 is the near-universal pad channel. */
  padFor(note, channel) {
    const learned = this.map.pads.findIndex((m) => m != null && m === note);
    if (learned >= 0) return learned;
    if (this.map.pads.length) return -1;
    if (channel === 9 && note >= 36 && note <= 43) return note - 36;
    return -1;
  }
}
