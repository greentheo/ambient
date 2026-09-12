// A short walk through the instrument for someone opening it for the first
// time. It runs once, and can be started again from the help panel.
//
// Each step points at something real on the page rather than describing it in
// the abstract — the thing lights up while you read about it.

const SEEN = 'ambient.tour.seen';

export const STEPS = [
  {
    sel: '.pad',
    title: 'Eight pads',
    body: 'Each one holds a sound and grinds it into overlapping grains. Three '
        + 'are already loaded. Press the ▶ on a pad — or the number keys 1–8 — '
        + 'to fade one in.',
  },
  {
    sel: '.pad canvas',
    title: 'Play the waveform',
    body: 'Drag across a pad to move through the sound and open or close its '
        + 'filter. Hold Shift while dragging for pitch and grain size. This is '
        + 'the main way you play it.',
  },
  {
    sel: '.orbit-strip',
    title: 'Nothing is in step',
    body: 'Every pad sweeps its sound on its own clock — 7.3 seconds, 11.1, '
        + '4.7. They drift against each other and will not line up again for '
        + 'hours. That drift is the music.',
  },
  {
    sel: '#params',
    title: 'The dials',
    body: 'Drag any dial up or down. Grain and Density change the texture, '
        + 'Tone and Sweep put the filter in motion, Cycle sets how fast this '
        + 'pad travels through its sound.',
  },
  {
    sel: '.scenes-strip',
    title: 'Scenes',
    body: 'Store the whole state into A, B, C or D, change things, then Morph '
        + 'back over up to three minutes. It is how a piece moves without a '
        + 'timeline.',
  },
  {
    sel: '[data-tab="sources"]',
    title: 'Your own sounds',
    body: 'Drop an audio file onto any pad, forge one from scratch, or record '
        + 'yourself — singing, a guitar, a room — and granulate that.',
  },
  {
    sel: '#btn-rec',
    title: 'When it sounds good',
    body: 'Record captures everything you hear and hands you a WAV. '
        + 'Press ? at any time for the full list of keys.',
  },
];

export function shouldRun() {
  try { return !localStorage.getItem(SEEN); } catch { return false; }
}

export function markSeen() {
  try { localStorage.setItem(SEEN, '1'); } catch {}
}

export function runTour(onDone) {
  const veil = document.getElementById('tour');
  const card = document.getElementById('tour-card');
  const ring = document.getElementById('tour-ring');
  let at = 0;

  const place = () => {
    const step = STEPS[at];
    const el = document.querySelector(step.sel);
    document.getElementById('tour-title').textContent = step.title;
    document.getElementById('tour-body').textContent = step.body;
    document.getElementById('tour-count').textContent = `${at + 1} / ${STEPS.length}`;
    document.getElementById('tour-next').textContent =
      at === STEPS.length - 1 ? 'Start playing' : 'Next';

    if (!el) { ring.style.display = 'none'; card.style.top = '50%'; card.style.left = '50%';
      card.style.transform = 'translate(-50%,-50%)'; return; }

    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Let the scroll settle before measuring, or the ring lands where the
    // element used to be.
    setTimeout(() => {
      const r = el.getBoundingClientRect();
      ring.style.display = '';
      ring.style.left = `${r.left - 6}px`;
      ring.style.top = `${r.top - 6}px`;
      ring.style.width = `${r.width + 12}px`;
      ring.style.height = `${r.height + 12}px`;

      const below = r.bottom + 20;
      const fits = below + 190 < innerHeight;
      card.style.transform = 'none';
      card.style.left = `${Math.max(14, Math.min(innerWidth - 340, r.left))}px`;
      card.style.top = fits ? `${below}px` : `${Math.max(14, r.top - 200)}px`;
    }, 260);
  };

  const end = () => {
    veil.classList.add('hidden');
    markSeen();
    // Walk them back to the top. The steps scroll down the page, and on a
    // phone the layout is tall enough that finishing mid-way leaves you
    // staring at empty pads, which reads as a blank screen.
    //
    // A step's scrollIntoView is queued on a timer, so it can land after this
    // and undo it — hence the second pass. Both scrollers are set because
    // whether the document or the body is the scrolling element depends on
    // the overflow rules in play.
    const toTop = () => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
    toTop();
    setTimeout(toTop, 320);
    if (onDone) onDone();
  };

  document.getElementById('tour-next').onclick = () => {
    if (++at >= STEPS.length) end(); else place();
  };
  document.getElementById('tour-skip').onclick = end;

  veil.classList.remove('hidden');
  at = 0;
  place();
}
