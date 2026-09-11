// Sound sources: procedurally generated starter material, plus decoding of
// files the user drops in. The generated buffers exist so the instrument
// makes sound the moment you open it, with no assets to download.

const SEED_LENGTH = 10; // seconds of material per generated source

function makeBuffer(ctx, seconds = SEED_LENGTH) {
  return ctx.createBuffer(2, Math.floor(seconds * ctx.sampleRate), ctx.sampleRate);
}

function normalise(buf, target = 0.7) {
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const m = Math.abs(d[i]);
      if (m > peak) peak = m;
    }
  }
  if (peak < 1e-6) return buf;
  const g = target / peak;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return buf;
}

// Stacked detuned partials that beat slowly against each other.
function genDrone(ctx, o) {
  const buf = makeBuffer(ctx, o.seconds);
  const rate = ctx.sampleRate;
  // A full harmonic series up towards Nyquist, with `character` setting how
  // fast it rolls off. A stack that stops a couple of kHz up leaves the Tone
  // control with nothing to remove, which is what made it feel broken.
  const root = o.root / 2;
  const maxPartial = Math.min(48, Math.floor((rate * 0.45) / root));
  const partials = [];
  for (let n = 1; n <= maxPartial; n++) partials.push(n);
  partials.splice(1, 0, 1.5);              // a fifth, for weight under the stack
  // Around 1.0 is a sawtooth, which is the classic subtractive-synth source
  // precisely because it gives the filter something to work on at every
  // setting. Below that gets reedy, above it goes soft and dark.
  const tilt = 1.5 - o.character * 0.9;    // 1.5 = warm, 0.6 = bright and reedy
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let p = 0; p < partials.length; p++) {
      const detune = 1 + (ch === 0 ? -1 : 1) * (0.0009 * (p + 1));
      const f = root * partials[p] * detune;
      const amp = 0.9 / Math.pow(partials[p], tilt);
      const phase = Math.random() * Math.PI * 2;
      // Each partial breathes at its own slow rate.
      const lfo = 0.03 + (p % 7) * 0.017;
      const lfoPhase = Math.random() * Math.PI * 2;
      if (f > rate * 0.45) continue;
      for (let i = 0; i < d.length; i++) {
        const t = i / rate;
        const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * lfo * t + lfoPhase);
        d[i] += Math.sin(2 * Math.PI * f * t + phase) * amp * env;
      }
    }
  }
  return normalise(buf);
}

// Noise pushed through a slowly opening and closing lowpass — wind, tape, air.
function genAir(ctx, o) {
  const buf = makeBuffer(ctx, o.seconds);
  const rate = ctx.sampleRate;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let z1 = 0, z2 = 0, z3 = 0;
    const lfoPhase = Math.random() * Math.PI * 2;
    for (let i = 0; i < d.length; i++) {
      const t = i / rate;
      // Coefficient wanders, so the noise has movement rather than sitting
      // still. It has to stay well clear of 1.0 — up there the cascade
      // attenuates so hard the sound simply vanishes.
      const centre = 0.88 - o.character * 0.14;
      const a = centre + 0.06 * Math.sin(2 * Math.PI * 0.045 * t + lfoPhase);
      const n = Math.random() * 2 - 1;
      z1 = n * (1 - a) + z1 * a;
      z2 = z1 * (1 - a) + z2 * a;
      z3 = z2 * (1 - a) + z3 * a;
      d[i] = z3;
    }
  }
  return normalise(buf, 0.6);
}

// Inharmonic bell partials struck at random points through the buffer.
function genBells(ctx, o) {
  const buf = makeBuffer(ctx, o.seconds);
  const rate = ctx.sampleRate;
  const ratios = [1, 2.76, 5.40, 8.93, 13.34];
  const scale = [0, 3, 5, 7, 10]; // minor pentatonic, semitones from root
  const root = o.root * 2;
  const strikes = 6 + Math.round(o.character * 18);

  for (let s = 0; s < strikes; s++) {
    const start = Math.floor(Math.random() * (d0Len(buf) - rate * 3));
    const note = scale[Math.floor(Math.random() * scale.length)] + 12 * Math.floor(Math.random() * 2);
    const f0 = root * Math.pow(2, note / 12);
    const pan = Math.random();
    const dur = Math.floor(rate * (1.5 + Math.random() * 1.5));
    for (let p = 0; p < ratios.length; p++) {
      const f = f0 * ratios[p];
      if (f > rate * 0.45) continue;
      const amp = 0.8 / (p + 1.5);
      const decay = 3 + p * 1.6;
      const phase = Math.random() * Math.PI * 2;
      for (let i = 0; i < dur; i++) {
        const idx = start + i;
        if (idx >= d0Len(buf)) break;
        const t = i / rate;
        const env = Math.exp(-decay * t / 3);
        const v = Math.sin(2 * Math.PI * f * t + phase) * amp * env;
        buf.getChannelData(0)[idx] += v * (1 - pan);
        buf.getChannelData(1)[idx] += v * pan;
      }
    }
  }
  return normalise(buf);
}

function d0Len(buf) { return buf.getChannelData(0).length; }

export const SEEDS = [
  { id: 'drone', name: 'Drone',  gen: genDrone },
  { id: 'air',   name: 'Air',    gen: genAir },
  { id: 'bells', name: 'Bells',  gen: genBells },
];

// Roots offered in the forge, as note name -> Hz.
export const ROOTS = [
  { name: 'C',  hz: 130.81 }, { name: 'D',  hz: 146.83 },
  { name: 'Eb', hz: 155.56 }, { name: 'F',  hz: 174.61 },
  { name: 'G',  hz: 196.00 }, { name: 'Ab', hz: 207.65 },
  { name: 'A',  hz: 220.00 }, { name: 'Bb', hz: 233.08 },
];

export function generateSeed(ctx, id, opts = {}) {
  const seed = SEEDS.find(s => s.id === id) || SEEDS[0];
  return seed.gen(ctx, {
    root: opts.root ?? 220,
    character: opts.character ?? 0.5,
    seconds: opts.seconds ?? SEED_LENGTH,
  });
}

export async function decodeFile(ctx, file) {
  const bytes = await file.arrayBuffer();
  return await ctx.decodeAudioData(bytes);
}

// Granular playback reads grains backwards as often as forwards, so every
// source keeps a reversed twin alongside it.
export function reverseBuffer(ctx, buf) {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    const dst = out.getChannelData(ch);
    const n = src.length;
    for (let i = 0; i < n; i++) dst[i] = src[n - 1 - i];
  }
  return out;
}
