// Seeded noise, so a world can be found again by its number.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 1-D value noise — the basis of every ridge line in the world. */
export function makeNoise(rand) {
  const n = 512;
  const table = new Float32Array(n);
  for (let i = 0; i < n; i++) table[i] = rand();
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    const a = table[((i % n) + n) % n];
    const b = table[(((i + 1) % n) + n) % n];
    return a + (b - a) * s;
  };
}

/** Several octaves of it, for terrain that has both bulk and detail. */
export function fbm(noise, x, octaves = 5) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
