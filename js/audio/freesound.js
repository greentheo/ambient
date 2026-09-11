// Freesound search. Needs a free API key from
// https://freesound.org/apiv2/apply/ — it is stored in localStorage and only
// ever sent to freesound.org.
//
// This loads the *preview* renders rather than the originals. Full-quality
// downloads are behind OAuth, and for material that is about to be shattered
// into grains and drowned in reverb, the preview is not the weak link.

const KEY_STORE = 'ambient.freesound.key';
const API = 'https://freesound.org/apiv2';

export function getKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
}
export function setKey(k) {
  try { localStorage.setItem(KEY_STORE, k.trim()); } catch {}
}

/**
 * @param {string} query
 * @param {{minDuration?:number, maxDuration?:number, page?:number}} [opts]
 */
export async function search(query, opts = {}) {
  const key = getKey();
  if (!key) throw new Error('No API key set');

  const min = opts.minDuration ?? 5;
  const max = opts.maxDuration ?? 90;
  const params = new URLSearchParams({
    query,
    filter: `duration:[${min} TO ${max}]`,
    sort: 'rating_desc',
    page_size: '20',
    page: String(opts.page ?? 1),
    fields: 'id,name,username,duration,license,previews',
    token: key,
  });

  const res = await fetch(`${API}/search/text/?${params}`);
  if (res.status === 401 || res.status === 403) throw new Error('API key rejected');
  if (!res.ok) throw new Error(`Freesound returned ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({
    id: r.id,
    name: r.name,
    user: r.username,
    duration: r.duration,
    license: r.license,
    url: r.previews['preview-hq-mp3'] || r.previews['preview-lq-mp3'],
    page: `https://freesound.org/s/${r.id}/`,
  }));
}

/** Fetch and decode a preview into an AudioBuffer. */
export async function load(ctx, result) {
  let res;
  try {
    res = await fetch(result.url);
  } catch (err) {
    // The API itself allows cross-origin reads; the CDN that serves the
    // preview files may not. If that is what happened, the sound is still
    // one manual download and drag away.
    throw new Error(
      'Could not fetch the preview — the browser blocked it. ' +
      'Open the sound page and drop the file onto a pad instead.'
    );
  }
  if (!res.ok) throw new Error(`Preview fetch returned ${res.status}`);
  const bytes = await res.arrayBuffer();
  return await ctx.decodeAudioData(bytes);
}
