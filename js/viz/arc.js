// The shape of a world's time.
//
// Not every place is a full day. A set might live entirely in a sunset, or
// never see the sun at all. A scene declares an arc — a few keyframes of sun
// elevation across normalised time — and the host runs the clock along it.
//
// `?day=<seconds>` scales the whole arc, so the same shape can be a four
// minute piece or a forty minute one.

export const ARCS = {
  // A whole day and night, looping.
  transit: {
    loop: true,
    az: [0.04, 0.96],
    keys: [
      { t: 0, sun: 0.50 }, { t: 0.30, sun: 0.05 }, { t: 0.42, sun: -0.32 },
      { t: 0.78, sun: -0.34 }, { t: 0.92, sun: 0.05 }, { t: 1, sun: 0.50 },
    ],
  },
  // One long descent across the whole set, then it holds.
  sunset: {
    loop: false,
    // Crosses from mid-sky down to the west, so it stays in frame the whole way.
    az: [0.46, 0.93],
    keys: [
      { t: 0, sun: 0.46 }, { t: 0.45, sun: 0.10 }, { t: 0.70, sun: -0.06 },
      { t: 1, sun: -0.32 },
    ],
  },
  sunrise: {
    loop: false,
    az: [0.07, 0.54],
    keys: [
      { t: 0, sun: -0.32 }, { t: 0.35, sun: -0.08 }, { t: 0.62, sun: 0.06 },
      { t: 1, sun: 0.48 },
    ],
  },
  // Never gets light. The sun stays under, the moon does the work.
  night: {
    loop: true,
    az: [0.04, 0.96],
    keys: [{ t: 0, sun: -0.28 }, { t: 0.5, sun: -0.38 }, { t: 1, sun: -0.28 }],
  },
  // Never gets dark. Flat overcast daylight.
  day: {
    loop: true,
    az: [0.04, 0.96],
    keys: [{ t: 0, sun: 0.38 }, { t: 0.5, sun: 0.54 }, { t: 1, sun: 0.38 }],
  },
};

function lerp(a, b, t) { return a + (b - a) * t; }

/** Sun elevation at normalised time u (0..1) along an arc. */
export function sunAt(arc, u) {
  const keys = arc.keys;
  const t = arc.loop ? ((u % 1) + 1) % 1 : Math.max(0, Math.min(1, u));
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return lerp(a.sun, b.sun, k * k * (3 - 2 * k));   // ease, so no corners
    }
  }
  return keys[keys.length - 1].sun;
}

/**
 * Where across the sky the sun sits, 0 (left) to 1 (right). Elevation alone
 * is not enough — without this the disc can sit off the edge of the frame for
 * a whole arc while the sky brightens behind the mountains.
 */
export function azimuthAt(arc, u) {
  const [a, b] = arc.az || [0.04, 0.96];
  const t = arc.loop ? ((u % 1) + 1) % 1 : Math.max(0, Math.min(1, u));
  return a + (b - a) * t;
}

/** Name for where we are, derived from height and whether it is rising. */
export function phaseName(sun, rising) {
  if (sun > 0.26) return 'day';
  if (sun > 0.03) return rising ? 'morning' : 'evening';
  if (sun > -0.06) return rising ? 'dawn' : 'dusk';
  return 'night';
}

/**
 * Seconds until the sun next crosses the horizon, or null if it never does.
 * This is what makes the world playable-to: you can see the sunset coming.
 */
export function nextCrossing(arc, u, dayLength) {
  const now = sunAt(arc, u);
  const above = now > 0;
  const steps = 400;
  for (let i = 1; i <= steps; i++) {
    const ahead = u + i / steps;
    if (!arc.loop && ahead > 1) return null;
    if ((sunAt(arc, ahead) > 0) !== above) {
      return { seconds: (i / steps) * dayLength, to: above ? 'sunset' : 'sunrise' };
    }
  }
  return null;
}
