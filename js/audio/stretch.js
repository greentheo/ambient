// Spectral timestretch, the PaulStretch way: cut the source into long
// overlapping windows, keep each window's magnitude spectrum, throw its phase
// away and replace it with noise, then overlap-add the result at a much
// slower rate. Losing the phase is the whole point — it dissolves every
// transient and leaves only the harmonic colour, smeared out indefinitely.

const FFT_SIZE = 8192;          // ~186ms at 44.1k. Longer = smoother, slower.
const OVERLAP = 4;              // 75% overlap, so the windows sum flat.

/** Precomputed twiddle factors. Tables beat a recurrence badly at this size. */
function tables(n) {
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  return { cos, sin };
}

function fft(re, im, t, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = t.cos[k];
        const wi = inverse ? -t.sin[k] : t.sin[k];
        const a = i + j, b = a + half;
        const vr = re[b] * wr - im[b] * wi;
        const vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr;        im[a] += vi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function mixToMono(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  const ch = buffer.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

/**
 * @param {BaseAudioContext} ctx
 * @param {AudioBuffer} buffer   source
 * @param {number} factor        how much longer the result should be
 * @param {(p:number)=>void} [onProgress]  0..1
 * @returns {Promise<AudioBuffer>} stereo, decorrelated between channels
 */
export async function paulStretch(ctx, buffer, factor, onProgress) {
  const n = FFT_SIZE;
  const half = n >> 1;
  const t = tables(n);
  const mono = mixToMono(buffer);

  const hopOut = n / OVERLAP;
  const hopIn = hopOut / factor;
  const frames = Math.max(1, Math.ceil(mono.length / hopIn));
  const outLen = frames * hopOut + n;

  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));

  const out = ctx.createBuffer(2, outLen, ctx.sampleRate);
  const re = new Float32Array(n);
  const im = new Float32Array(n);

  // The two channels get independent random phases from the same source,
  // which is what gives a stretch its wide, diffuse stereo image.
  for (let ch = 0; ch < 2; ch++) {
    const dst = out.getChannelData(ch);
    for (let f = 0; f < frames; f++) {
      const inStart = Math.floor(f * hopIn);

      for (let i = 0; i < n; i++) {
        const s = inStart + i;
        re[i] = (s < mono.length ? mono[s] : 0) * win[i];
        im[i] = 0;
      }
      fft(re, im, t, false);

      // Keep the magnitudes, discard the phases, and impose conjugate
      // symmetry so the inverse transform comes back purely real.
      for (let k = 1; k < half; k++) {
        const mag = Math.hypot(re[k], im[k]);
        const th = Math.random() * 2 * Math.PI;
        const cr = mag * Math.cos(th), ci = mag * Math.sin(th);
        re[k] = cr;      im[k] = ci;
        re[n - k] = cr;  im[n - k] = -ci;
      }
      im[0] = 0;
      im[half] = 0;

      fft(re, im, t, true);

      const outStart = f * hopOut;
      for (let i = 0; i < n; i++) dst[outStart + i] += re[i] * win[i];

      if ((f & 15) === 0) {
        if (onProgress) onProgress((ch * frames + f) / (frames * 2));
        // Yield, or a long stretch locks the page for seconds.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = out.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const m = Math.abs(d[i]);
      if (m > peak) peak = m;
    }
  }
  if (peak > 0) {
    const g = 0.85 / peak;
    for (let ch = 0; ch < 2; ch++) {
      const d = out.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
  }
  if (onProgress) onProgress(1);
  return out;
}
