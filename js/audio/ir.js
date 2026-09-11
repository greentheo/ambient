// Procedurally generated impulse responses. No binary assets — the reverb
// tail is synthesised from filtered, decaying noise at load time.

// One-pole lowpass, applied in-place. `a` is the smoothing coefficient
// (0 = no filtering, approaching 1 = very dark).
function onePole(data, a) {
  let z = 0;
  for (let i = 0; i < data.length; i++) {
    z = data[i] * (1 - a) + z * a;
    data[i] = z;
  }
}

/**
 * Build a stereo impulse response.
 * @param {BaseAudioContext} ctx
 * @param {number} seconds   tail length
 * @param {number} decay     higher = faster fade (2 = cathedral, 8 = room)
 * @param {number} darkness  0..1, how much high end is rolled off
 */
export function makeIR(ctx, seconds = 6, decay = 3, darkness = 0.6) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * rate));
  const buf = ctx.createBuffer(2, len, rate);
  // A short fade-in stops the tail from sounding like a gated noise burst.
  const attack = Math.floor(rate * 0.012);
  const a = 0.02 + darkness * 0.72;

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    onePole(d, a);

    let peak = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      let env = Math.pow(1 - t, decay);
      if (i < attack) env *= i / attack;
      d[i] *= env;
      const m = Math.abs(d[i]);
      if (m > peak) peak = m;
    }
    // Normalise so changing size/darkness doesn't change how loud the send is.
    if (peak > 0) {
      const g = 0.5 / peak;
      for (let i = 0; i < len; i++) d[i] *= g;
    }
  }
  return buf;
}
