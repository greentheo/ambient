// A set: the pieces you are going to play, in order, held in memory.
//
// The single decision everything else follows from: **the whole set is loaded
// before the show**. Decoding audio mid-performance means a file picker, a
// `decodeAudioData` on the main thread, and a gap — three things that must not
// happen between two pieces in front of people. So a piece is added once, its
// audio is decoded there and then, and from that moment the set never touches
// the disk again.
//
// A transition is a long morph. The Morpher already glides every parameter off
// the audio clock; what it cannot do is change what a pad is reading. So pads
// are split: the ones whose material carries over morph their parameters, and
// the ones whose material changes fade out on their own Fade out, swap while
// silent, and come back on their own Fade in. That is also what you would do
// by hand, which is why it sounds like a transition rather than a cut.

import { deserialize, decodeAudio } from './snapshots.js';

/**
 * Two sources are "the same material" if swapping would be inaudible.
 * Captures and dropped files have no stable id, so the pad's name stands in —
 * two pieces built from one capture carry the same name through the session.
 */
export function sameSource(a, b, nameA, nameB) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'forge') {
    return a.gen === b.gen && a.root === b.root && a.character === b.character;
  }
  if (a.kind === 'keys') {
    return a.wave === b.wave
      && JSON.stringify(a.seq || null) === JSON.stringify(b.seq || null);
  }
  return nameA === nameB;
}

export class Setlist {
  constructor(ctx) {
    this.ctx = ctx;
    this.pieces = [];      // { name, data, buffers }
    this.at = -1;          // index of the piece currently playing
    this.name = 'Untitled set';
  }

  get current() { return this.at >= 0 ? this.pieces[this.at] : null; }
  get next() { return this.pieces[this.at + 1] || null; }
  get length() { return this.pieces.length; }

  /**
   * Read a session file into the set, decoding its audio now rather than at
   * the moment it is needed.
   * @param {File} file
   * @param {number} [at] insert position; appended by default
   */
  async add(file, at = -1) {
    const data = deserialize(await file.text());
    const buffers = await decodeAudio(this.ctx, data);
    const piece = {
      name: file.name.replace(/\.json$/i, '').replace(/^ambient-session-/, ''),
      data,
      buffers,
    };
    if (at >= 0 && at < this.pieces.length) this.pieces.splice(at, 0, piece);
    else this.pieces.push(piece);
    return piece;
  }

  remove(i) {
    this.pieces.splice(i, 1);
    if (this.at >= this.pieces.length) this.at = this.pieces.length - 1;
  }

  move(from, to) {
    if (to < 0 || to >= this.pieces.length) return;
    const [p] = this.pieces.splice(from, 1);
    this.pieces.splice(to, 0, p);
    if (this.at === from) this.at = to;
  }

  /** Roughly how much memory the set is holding, for the warning line. */
  bytes() {
    let n = 0;
    for (const p of this.pieces) {
      for (const b of Object.values(p.buffers)) n += b.length * b.numberOfChannels * 4;
    }
    return n;
  }

  /**
   * Which pads keep their material across a change and which have to be
   * swapped. Called before the morph so the swaps can start fading first.
   * @param {Array} pads the live pad array
   * @param {object} piece the piece being moved to
   */
  plan(pads, piece) {
    const keep = [], swap = [];
    const sources = piece.data.sources || [];
    for (let i = 0; i < pads.length; i++) {
      const to = sources[i] || null;
      const same = sameSource(
        pads[i].source, to && to.source, pads[i].name, to && to.name,
      );
      (same ? keep : swap).push(i);
    }
    return { keep, swap };
  }

  /** The whole set as one file. Pieces already carry their own audio. */
  serialize() {
    return JSON.stringify({
      format: 'ambient-set',
      version: 1,
      name: this.name,
      pieces: this.pieces.map((p) => ({ name: p.name, session: p.data })),
    });
  }

  async load(text) {
    const d = JSON.parse(text);
    if (d.format !== 'ambient-set') throw new Error('not an Ambient set file');
    this.name = d.name || 'Untitled set';
    this.pieces = [];
    for (const p of d.pieces || []) {
      this.pieces.push({
        name: p.name,
        data: p.session,
        buffers: await decodeAudio(this.ctx, p.session),
      });
    }
    this.at = -1;
    return this.pieces.length;
  }
}
