// Live config for a world.
//
// A scene publishes a schema — what can be tuned, and within what range — and
// this builds the editor from it. Nothing here knows anything about valleys or
// towers, so a new world gets an editor for free by declaring its parameters.
//
// Values live in localStorage per world, and can be written out to a file so a
// look you like travels with the seed that made it.

const STORE = (world) => `ambient.viz.cfg.${world}`;

export function defaults(schema) {
  const out = {};
  for (const p of schema) out[p.k] = p.def;
  return out;
}

export function load(world, schema) {
  const cfg = defaults(schema);
  try {
    const raw = localStorage.getItem(STORE(world));
    if (raw) Object.assign(cfg, JSON.parse(raw));
  } catch { /* first run */ }
  return cfg;
}

export function save(world, cfg) {
  try { localStorage.setItem(STORE(world), JSON.stringify(cfg)); } catch {}
}

export function forget(world) {
  try { localStorage.removeItem(STORE(world)); } catch {}
}

/**
 * @param {object} opts
 *   schema    parameter list from the scene
 *   cfg       live values, mutated in place
 *   onChange  (key, needsRebuild) after every edit
 *   meta      { world, arc, seed, day } for the file header
 */
export function buildEditor({ schema, cfg, onChange, meta, onMeta }) {
  const root = document.getElementById('editor');
  root.innerHTML = '';

  const groups = [...new Set(schema.map((p) => p.group || 'World'))];
  for (const g of groups) {
    const sec = document.createElement('div');
    sec.className = 'ed-group';
    sec.innerHTML = `<h3>${g}</h3>`;
    for (const p of schema.filter((x) => (x.group || 'World') === g)) {
      sec.appendChild(row(p, cfg, onChange));
    }
    root.appendChild(sec);
  }

  const foot = document.createElement('div');
  foot.className = 'ed-group ed-foot';
  foot.innerHTML = `<h3>Config</h3>
    <div class="ed-row"><label>Seed</label>
      <input id="ed-seed" type="number" value="${meta.seed}"></div>
    <div class="ed-row"><label>Arc length (s)</label>
      <input id="ed-day" type="number" min="10" max="7200" value="${meta.day}"></div>
    <div class="ed-btns">
      <button id="ed-save">Save file</button>
      <button id="ed-load">Load file</button>
      <button id="ed-reset">Reset</button>
    </div>
    <input type="file" id="ed-file" accept=".json,application/json" hidden>
    <p class="ed-note">Edits apply live and are remembered for this world.</p>`;
  root.appendChild(foot);

  foot.querySelector('#ed-seed').addEventListener('change', (e) => onMeta('seed', +e.target.value));
  foot.querySelector('#ed-day').addEventListener('change', (e) => onMeta('day', +e.target.value));
  return foot;
}

function row(p, cfg, onChange) {
  const el = document.createElement('div');
  el.className = 'ed-row';
  const val = cfg[p.k];
  const dec = p.step >= 1 ? 0 : p.step >= 0.01 ? 2 : 3;
  el.innerHTML = `<label title="${p.hint || ''}">${p.label}</label>
    <input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${val}">
    <output>${(+val).toFixed(dec)}</output>`;
  const range = el.querySelector('input');
  const out = el.querySelector('output');
  range.addEventListener('input', () => {
    cfg[p.k] = +range.value;
    out.textContent = (+range.value).toFixed(dec);
    onChange(p.k, !!p.rebuild);
  });
  return el;
}

export function toFile(meta, cfg) {
  return JSON.stringify({
    format: 'ambient-world-config', version: 1, ...meta, params: cfg,
  }, null, 2);
}

export function fromFile(text) {
  const d = JSON.parse(text);
  if (d.format !== 'ambient-world-config') throw new Error('not an Ambient world config');
  return d;
}
