/* 24×7 — your week of weather, one screen.
 * Single-serving, chrome-less hourly temperature + precip grid.
 * Data: Open-Meteo (keyless, global, single request). No build step, no deps.
 */

const APP_NAME = '24×7';          // ← alt names: 'hotmap', 'wgrid'. One-line swap.
const LS = {
  settings: 'grid.settings',
  cache:    'grid.cache',         // last forecast payload, for instant paint
};
const CACHE_TTL = 90 * 60 * 1000; // 90 min: render stale instantly, refresh quietly

/* ---------- Settings ---------- */
const DEFAULTS = {
  view: 'temp',         // 'temp' | 'run'
  palette: 'noaa',      // 'noaa' | 'inferno'  (temperature view)
  unit: 'auto',         // 'auto' | 'f' | 'c'
  clock: 'auto',        // 'auto' | '12' | '24'
  showNumbers: true,
  fogWidth: 8,          // mist strand line-width multiplier
  fogOpacity: 0.025,    // mist strand opacity
  runCurves: null,      // per-dimension preference curves (validated in loadSettings)
  loc: null,            // { lat, lon, name, admin } manual override
};

/* ---------- Run Index model ----------
 * Each dimension maps a weather value to a 0–1 "score" via a user-drawn preference
 * curve (control points every `step` from min→max). The hourly run index is the
 * geometric mean of the available dimension scores, so any one "avoid" tanks it
 * while everything "fine" lands mid-scale. def[] are the 0–1 starting points. */
const RUN_DIMS = [
  { key: 'temp', label: 'Temperature', unit: '°F', min: 0, max: 100, step: 10,
    value: c => cToF(c.c), def: [0, 0, 0, .5, .5, 1, 1, 1, .5, .5, 0] },
  { key: 'dew', label: 'Dew point', unit: '°F', min: 30, max: 80, step: 5,
    value: c => c.dewF, def: [1, 1, 1, 1, .9, .75, .55, .35, .2, .1, 0] },
  { key: 'wind', label: 'Wind speed', unit: 'mph', min: 0, max: 40, step: 5,
    value: c => c.windMph, def: [1, 1, .8, .6, .4, .3, .2, .1, 0] },
  { key: 'pop', label: 'Precip chance', unit: '%', min: 0, max: 100, step: 10,
    value: c => c.pop, def: [1, 1, .9, .7, .5, .4, .3, .2, .15, .1, 0] },
  { key: 'intensity', label: 'Precip intensity', unit: '', min: 0, max: 5, step: 1,
    value: c => precipLevel(c), def: [1, .8, .55, .35, .15, 0],
    ticks: ['none', 'mist', 'driz', 'light', 'mod', 'heavy'] },
];
const dimPoints = d => (d.max - d.min) / d.step + 1;

/* Y-axis snap tiers (also drawn as guide lines). 7 detents 0–6; only 0/3/6 labeled.
 * `y` is the 0–1 score; edit this list to change snap points or labels. */
const TIERS = [
  { y: 0, l: 'avoid' }, { y: 1 / 6, l: '' }, { y: 2 / 6, l: '' }, { y: 3 / 6, l: 'fine' },
  { y: 4 / 6, l: '' }, { y: 5 / 6, l: '' }, { y: 1, l: 'great' },
];
function snapTier(y){
  let best = TIERS[0].y, bd = Infinity;
  for (const t of TIERS){ const d = Math.abs(t.y - y); if (d <= bd){ bd = d; best = t.y; } }  // ties → higher tier
  return best;
}

let settings = loadSettings();

function loadSettings(){
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS.settings) || '{}') }; }
  catch { s = { ...DEFAULTS }; }
  const curves = s.runCurves || {};
  s.runCurves = {};
  for (const d of RUN_DIMS){
    const c = curves[d.key];
    const raw = (Array.isArray(c) && c.length === dimPoints(d)) ? c.map(Number) : d.def;
    s.runCurves[d.key] = raw.map(snapTier);     // align stored values to the snap tiers
  }
  return s;
}
function saveSettings(){ localStorage.setItem(LS.settings, JSON.stringify(settings)); }

function precipLevel(cell){ const k = precipKind(cell); return k ? k.level : 0; }
function curveScore(dim, curve, v){
  const t = (Math.max(dim.min, Math.min(dim.max, v)) - dim.min) / dim.step;
  const i = Math.floor(t), f = t - i;
  if (i >= curve.length - 1) return curve[curve.length - 1];
  return curve[i] * (1 - f) + curve[i + 1] * f;
}

/* ---------- Locale helpers ---------- */
const usLocale = () => {
  const l = (navigator.language || 'en-US');
  return /^en-US|^en-AS|^en-GU|^en-MP|^en-PR|^en-UM|^en-VI/i.test(l) || l === 'en';
};
function unitIsF(){ return settings.unit === 'f' || (settings.unit === 'auto' && usLocale()); }
function clock24(){ return settings.clock === '24' || (settings.clock === 'auto' && !usLocale()); }

/* ---------- Temp conversion + palettes ---------- */
const cToF = c => c * 9 / 5 + 32;
const displayTemp = c => unitIsF() ? cToF(c) : c;
const unitGlyph = () => unitIsF() ? '°F' : '°C';
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const rgbStr = ([r,g,b]) => `rgb(${r},${g},${b})`;

/* Official NWS/NDFD temperature palette, decoded from the graphical-forecast
 * legend swatches (mapservices.weather.noaa.gov · NDFD_temp). [°F, [r,g,b]]. */
const NOAA_STOPS = [
  [-40,[255,230,255]],[-30,[255,222,255]],[-25,[255,201,255]],[-20,[255,148,255]],
  [-15,[255,92,255]],[-10,[255,0,255]],[-5,[204,0,255]],[0,[140,0,255]],
  [5,[81,0,255]],[10,[23,31,255]],[15,[51,88,255]],[20,[59,147,255]],
  [25,[51,194,255]],[30,[23,255,240]],[35,[46,255,182]],[40,[48,255,135]],
  [45,[38,255,78]],[50,[47,255,0]],[55,[119,255,0]],[60,[170,255,0]],
  [65,[221,255,0]],[70,[255,251,0]],[75,[255,217,0]],[80,[255,179,0]],
  [85,[255,149,0]],[90,[245,118,0]],[95,[217,94,0]],[100,[176,56,0]],
  [105,[153,36,0]],[110,[128,0,0]],
];
/* Perceptual colormaps (bids.github.io/colormap), 9 evenly-spaced anchors. */
const INFERNO = [[0,0,4],[31,12,72],[85,15,109],[136,34,106],[186,54,85],[227,89,51],[249,140,10],[249,201,50],[252,255,164]];
const VIRIDIS = [[68,1,84],[72,40,120],[62,73,137],[49,104,142],[38,130,142],[31,158,137],[53,183,121],[110,206,88],[253,231,37]];

function rampStops(stops, f){
  if (f <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (f >= last[0]) return last[1];
  for (let i = 0; i < stops.length - 1; i++){
    if (f >= stops[i][0] && f < stops[i+1][0]){
      const k = (f - stops[i][0]) / (stops[i+1][0] - stops[i][0]), a = stops[i][1], b = stops[i+1][1];
      return [lerp(a[0],b[0],k), lerp(a[1],b[1],k), lerp(a[2],b[2],k)];
    }
  }
  return last;
}
function sample(arr, x){                 // x in 0..1 across evenly-spaced anchors
  x = Math.max(0, Math.min(1, x));
  const n = arr.length - 1, f = x * n, i = Math.floor(f), k = f - i;
  if (i >= n) return arr[n];
  const a = arr[i], b = arr[i+1];
  return [lerp(a[0],b[0],k), lerp(a[1],b[1],k), lerp(a[2],b[2],k)];
}
const INF_LO = -20, INF_HI = 110;        // °F domain for the Inferno temp ramp
function tempRGB(f){
  if (f == null || Number.isNaN(f)) return [17,21,28];
  return settings.palette === 'inferno'
    ? sample(INFERNO, (f - INF_LO) / (INF_HI - INF_LO))
    : rampStops(NOAA_STOPS, f);
}
const runRGB = idx => idx == null ? [17,21,28] : sample(VIRIDIS, idx / 100);

/* Contrast: black by default, white only when it reads better (WCAG luminance). */
function pickInk([r,g,b]){
  const s = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
  const L = 0.2126*s(r) + 0.7152*s(g) + 0.0722*s(b);
  return (1.05/(L+0.05)) > ((L+0.05)/0.05) ? '#fff' : '#000';
}

/* ---------- Precipitation: probability (opacity) + intensity (style) ---------- */
const mmToIn = mm => mm / 25.4;
// intensity levels 1–5; tuned in CSS via .l1–.l5
const RAIN_LABEL = { 1:'misty', 2:'drizzle', 3:'light rain', 4:'moderate rain', 5:'downpour' };
const SNOW_LABEL = { 1:'flurries', 2:'light snow', 3:'moderate snow', 4:'heavy snow', 5:'heavy snow' };
function precipKind(cell){
  if (!cell) return null;
  const pop = cell.pop || 0;
  const inch = mmToIn(cell.precip || 0);
  const isSnow = (cell.snow || 0) > 0;
  if (pop <= 0 && inch <= 0) return null;       // nothing to show
  let level;
  if (isSnow){
    const r = inch * 10;                          // ~liquid→snow ratio
    level = r < 0.1 ? 1 : r < 0.3 ? 2 : r < 0.6 ? 3 : 4;
  } else if (inch <= 0){
    level = pop >= 60 ? 2 : 1;                    // chance but no forecast amount
  } else {
    level = inch < 0.02 ? 1 : inch < 0.04 ? 2 : inch < 0.06 ? 3 : inch < 0.10 ? 4 : 5;
  }
  return { level, pop, snow: isSnow, label: (isSnow ? SNOW_LABEL : RAIN_LABEL)[level] };
}

/* Run Index (stub — refined later). 0 (bad) → 100 (perfect run weather). */
function runIndex(cell){
  // Geometric mean of each dimension's preference score (skip dims with no data).
  let logSum = 0, n = 0;
  for (const dim of RUN_DIMS){
    const v = dim.value(cell);
    if (v == null || Number.isNaN(v)) continue;
    const s = Math.max(0, Math.min(1, curveScore(dim, settings.runCurves[dim.key], v)));
    if (s <= 0) return 0;                          // any "avoid" tanks the hour
    logSum += Math.log(s); n++;
  }
  if (!n) return 50;
  return Math.round(100 * Math.exp(logSum / n));
}
// Debug: per-dimension value → score, for the tap popup.
function runBreakdown(cell){
  return RUN_DIMS.map(dim => {
    const v = dim.value(cell);
    if (v == null || Number.isNaN(v)) return { label: dim.label, val: '—', s: null };
    const s = Math.max(0, Math.min(1, curveScore(dim, settings.runCurves[dim.key], v)));
    const val = dim.ticks
      ? dim.ticks[Math.max(0, Math.min(dim.ticks.length - 1, Math.round(v)))]
      : `${Math.round(v)}${dim.unit || ''}`;
    return { label: dim.label, val, s };
  });
}

/* ---------- Time formatting ---------- */
const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function fmtHour(h){
  if (clock24()) return String(h).padStart(2,'0');
  if (h === 0) return '12a'; if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h-12}p`;
}
function fmtHourLong(h){
  if (clock24()) return `${String(h).padStart(2,'0')}:00`;
  if (h === 0) return '12 AM'; if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h-12} PM`;
}

/* ---------- State ---------- */
let days = [];        // [{ date:Date, label, isToday, cells:[{c,pop,appF,windMph,rh,iso,past,now}|null x24] }]
let place = { name: '—', sub: '' };
let orientation = null;

/* ---------- DOM ---------- */
const $ = sel => document.querySelector(sel);
const gridEl = $('#grid');
const tipEl = $('#tip');
const sheetEl = $('#settings');

const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

/* ---------- Data: Open-Meteo ---------- */
function buildUrl(lat, lon){
  const p = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: 'temperature_2m,precipitation_probability,precipitation,snowfall,apparent_temperature,dewpoint_2m,relative_humidity_2m,wind_speed_10m',
    daily: 'sunrise,sunset',
    wind_speed_unit: 'mph',
    timezone: 'auto',
    forecast_days: '7',
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}

async function fetchForecast(lat, lon){
  const r = await fetch(buildUrl(lat, lon));
  if (!r.ok) throw new Error(`Weather HTTP ${r.status}`);
  return r.json();
}

/* Parse Open-Meteo hourly arrays into day columns of 24 hours each. */
function toDays(j){
  const h = j.hourly || {};
  const time = h.time || [];
  const byDate = new Map();
  const todayKey = ymd(new Date());

  for (let i = 0; i < time.length; i++){
    const iso = time[i];
    const dateKey = iso.slice(0, 10);
    const hour = +iso.slice(11, 13);
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Array(24).fill(null));
    byDate.get(dateKey)[hour] = {
      c: h.temperature_2m?.[i],
      pop: h.precipitation_probability?.[i] ?? 0,
      precip: h.precipitation?.[i] ?? 0,          // mm in this hour
      snow: h.snowfall?.[i] ?? 0,                 // cm in this hour
      appF: h.apparent_temperature != null ? cToF(h.apparent_temperature[i]) : null,
      dewF: h.dewpoint_2m != null ? cToF(h.dewpoint_2m[i]) : null,
      windMph: h.wind_speed_10m?.[i] ?? null,
      rh: h.relative_humidity_2m?.[i] ?? null,
      iso,
    };
  }

  // daily sunrise/sunset, keyed by date → fractional hour of day (0–24)
  const dly = j.daily || {};
  const sun = new Map();
  (dly.time || []).forEach((d, i) => {
    const toH = s => { if (!s) return null; const t = new Date(s); return t.getHours() + t.getMinutes() / 60; };
    sun.set(d, { riseH: toH(dly.sunrise?.[i]), setH: toH(dly.sunset?.[i]) });
  });

  return [...byDate.entries()].slice(0, 7).map(([key]) => {
    const d = new Date(key + 'T00:00:00');
    const s = sun.get(key) || {};
    return {
      date: d,
      isToday: key === todayKey,
      dow: WD[d.getDay()],
      dnum: d.getDate(),
      cells: byDate.get(key),
      riseH: s.riseH ?? null,     // sunrise as fractional hour, or null
      setH: s.setH ?? null,
    };
  });
}
const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

/* Empty 7-day scaffold so the loading shimmer has cells to fill. */
function placeholderDays(){
  const out = [];
  const base = new Date(); base.setHours(0,0,0,0);
  for (let i = 0; i < 7; i++){
    const d = new Date(base.getTime() + i*86400000);
    out.push({ date:d, isToday:i===0, dow:WD[d.getDay()], dnum:d.getDate(), cells:new Array(24).fill(null) });
  }
  return out;
}

/* ---------- Rendering ---------- */
function isPortrait(){ return window.innerHeight >= window.innerWidth; }

function cellRGB(cell){
  if (!cell || cell.c == null) return [17,21,28];
  return settings.view === 'run' ? runRGB(runIndex(cell)) : tempRGB(cToF(cell.c));
}
function cellNumber(cell){
  if (!settings.showNumbers || !cell || cell.c == null) return null;
  return settings.view === 'run' ? String(runIndex(cell)) : String(Math.round(displayTemp(cell.c)));
}

let nowFrac = 0;
function nowLineEl(){
  const el = document.createElement('div');
  el.className = 'nowline';
  el.style.setProperty('--frac', nowFrac.toFixed(4));
  return el;
}
/* Smooth day/night darkness as a continuous function of fractional hour, fading
 * across a twilight band around sunrise/sunset — deliberately ignores cell edges. */
const MAXDARK = 0.72, TWI = 1.3;          // peak night darkness; twilight half-width (hours)
function smoothstep(e0, e1, x){ const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
function darknessAt(day, t){
  if (day?.riseH == null || day?.setH == null) return 0;
  const dayness = smoothstep(day.riseH - TWI, day.riseH + TWI, t) * (1 - smoothstep(day.setH - TWI, day.setH + TWI, t));
  return MAXDARK * (1 - dayness);
}
function shadeGradient(day, portrait){
  const dir = portrait ? 'to bottom' : 'to right', stops = [], N = 48;
  for (let i = 0; i <= N; i++){
    const a = darknessAt(day, i / N * 24);
    stops.push(`rgba(0,0,0,${a.toFixed(3)}) ${(i / N * 100).toFixed(2)}%`);
  }
  return `linear-gradient(${dir}, ${stops.join(',')})`;
}
function dayShadeEl(day, di, portrait){
  if (day.riseH == null || day.setH == null) return null;
  const el = document.createElement('div');
  el.className = 'dayshade';
  if (portrait){ el.style.gridColumn = `${di + 2}`; el.style.gridRow = '2 / span 24'; }
  else { el.style.gridRow = `${di + 2}`; el.style.gridColumn = '2 / span 24'; }
  el.style.background = shadeGradient(day, portrait);
  return el;
}
// Ink that accounts for the night shade so numbers stay legible.
function effInk(di, h, c){
  const d = darknessAt(days[di], h + 0.5);
  return d ? pickInk([c[0] * (1 - d), c[1] * (1 - d), c[2] * (1 - d)]) : pickInk(c);
}
// Re-placeable current-time line: located by data-attrs after the grid is in the DOM.
function placeNowLine(){
  gridEl.querySelectorAll('.nowline').forEach(n => n.remove());
  const di = days.findIndex(d => d.isToday);
  if (di < 0) return;
  const now = new Date();
  nowFrac = now.getMinutes() / 60;
  const cell = gridEl.querySelector(`.cell[data-di="${di}"][data-h="${now.getHours()}"]`);
  if (cell && !cell.classList.contains('empty')) cell.appendChild(nowLineEl());
}

function corner(){
  const el = document.createElement('div');
  el.className = 'corner';
  el.innerHTML = GEAR;
  el.title = 'Settings';
  el.addEventListener('click', openSheet);
  return el;
}
function dayHead(day){
  const el = document.createElement('div');
  el.className = 'head day' + (day.isToday ? ' today' : '');
  el.innerHTML = `<span class="dow">${day.dow}</span><span class="dnum">${day.dnum}</span>`;
  return el;
}
function hourHead(h){
  const el = document.createElement('div');
  el.className = 'head hour';
  el.textContent = fmtHour(h);
  return el;
}
function cellEl(di, h){
  const cell = days[di].cells[h];
  const el = document.createElement('div');
  el.className = 'cell';
  el.dataset.di = di; el.dataset.h = h;
  if (!cell || cell.c == null){ el.classList.add('empty'); return el; }

  const c = cellRGB(cell);
  el.style.background = rgbStr(c);
  const ink = effInk(di, h, c);           // contrast vs the night-shaded color

  const kind = precipKind(cell);
  if (kind) fx.cells.push({ el, kind, ink });   // canvas layer draws the particles

  const num = cellNumber(cell);
  if (num != null){
    const t = document.createElement('span');
    t.className = 't';
    t.style.color = ink;
    t.textContent = num;
    el.appendChild(t);
  }
  return el;
}

function render(){
  if (!days.length) return;
  const portrait = isPortrait();
  orientation = portrait ? 'p' : 'l';
  nowFrac = new Date().getMinutes() / 60;
  const n = days.length;
  const frag = document.createDocumentFragment();
  gridEl.className = 'grid ' + orientation;
  fx.cells = [];                          // collected by cellEl, laid out after paint

  if (portrait){
    // days = columns, hours = rows
    gridEl.style.gridTemplateColumns = `var(--label) repeat(${n}, minmax(0,1fr))`;
    gridEl.style.gridTemplateRows = `var(--label-day) repeat(24, minmax(0,1fr))`;
    frag.appendChild(corner());
    days.forEach(d => frag.appendChild(dayHead(d)));
    for (let h = 0; h < 24; h++){
      frag.appendChild(hourHead(h));
      for (let di = 0; di < n; di++) frag.appendChild(cellEl(di, h));
    }
  } else {
    // hours = columns, days = rows
    gridEl.style.gridTemplateColumns = `var(--label-day) repeat(24, minmax(0,1fr))`;
    gridEl.style.gridTemplateRows = `var(--label) repeat(${n}, minmax(0,1fr))`;
    frag.appendChild(corner());
    for (let h = 0; h < 24; h++) frag.appendChild(hourHead(h));
    days.forEach((d, di) => {
      frag.appendChild(dayHead(d));
      for (let h = 0; h < 24; h++) frag.appendChild(cellEl(di, h));
    });
  }
  days.forEach((d, di) => { const s = dayShadeEl(d, di, portrait); if (s) frag.appendChild(s); });
  gridEl.replaceChildren(frag);
  placeNowLine();                         // now that cells are in the DOM
  requestAnimationFrame(layoutFx);        // measure cell rects once laid out
}

/* ---------- Precipitation particle engine (canvas) ----------
 * One overlay canvas draws every rainy/snowy cell's particles. Probability sets
 * overall opacity; intensity sets drop count, fall speed and streak length. A
 * slow gusting wind angle shared across the grid keeps it alive and cohesive. */
const fx = { cells: [], canvas: null, ctx: null, dpr: 1, w: 0, h: 0, raf: 0, last: 0, t: 0, fogScale: 1 };
const FOG_BUDGET = 180;                   // max total mist strands across the whole grid
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// per-intensity tuning: seconds to cross a cell, drops-per-cell base, line width
const RAIN_T  = [0, 1.15, 0.85, 0.60, 0.44, 0.32];
const RAIN_N  = [0,    3,    5,    8,   11,   14];
const RAIN_LW = [0,  0.8,  0.9,  1.1,  1.3,  1.6];
const SNOW_T  = [0,    6,    5,    4,    3,    3];
const SNOW_N  = [0,    5,    9,   13,   17,   17];
const SNOW_R  = [0,  0.9,  1.1,  1.4,  1.7,  1.7];
const REF_AREA = 40 * 34;                 // a "typical" cell, for scaling counts
const FOG_AMP = 0.6;                      // mist wave height as a fraction of cell height

function rand(a, b){ return a + Math.random() * (b - a); }

function buildParticles(cell){
  const { w, h, kind } = cell;
  cell.col = cell.ink === '#fff' ? '255,255,255' : '0,0,0';
  cell.alpha = 0.30 + 0.55 * Math.min(1, kind.pop / 100);
  const areaScale = Math.max(0.45, Math.min(2.4, (w * h) / REF_AREA));
  cell.type = kind.snow ? 'snow' : (kind.level === 1 ? 'fog' : 'rain');

  if (cell.type === 'fog'){
    // wavy drifting mist strands instead of falling streaks
    // opacity tracks precip probability: faint when unlikely, full at high chance.
    // Probability is the dominant factor (0.15→1.0); jitter is only a light texture.
    const probScale = 0.15 + 0.85 * Math.min(1, kind.pop / 100);
    const n = Math.max(1, Math.round(3.5 * areaScale * fx.fogScale));
    cell.parts = Array.from({ length: n }, () => ({
      by: rand(0.16 * h, 0.84 * h),
      ampF: rand(0.7, 1.3),                      // amplitude/opacity are scaled by
      aF: rand(0.9, 1.1) * probScale,            // the live sliders at draw time
      k: (Math.PI * 2 / w) * rand(0.7, 1.7),     // ~1 wave across the cell
      ph: rand(0, Math.PI * 2),
      drift: rand(0.25, 0.8) * (Math.random() < 0.5 ? -1 : 1),  // wave travel
      vx: rand(6, 18) * (Math.random() < 0.5 ? -1 : 1),         // sideways slide px/s
      ox: rand(0, w),
      lw: rand(1.3, 3),
    }));
  } else if (cell.type === 'snow'){
    const lvl = Math.min(4, kind.level);
    const T = SNOW_T[lvl], n = Math.max(2, Math.round(SNOW_N[lvl] * areaScale));
    cell.parts = Array.from({ length: n }, () => ({
      bx: rand(0, w), y: rand(0, h), r: SNOW_R[lvl] * rand(0.7, 1.3),
      vy: (h / T) * rand(0.75, 1.25), amp: w * rand(0.08, 0.22),
      freq: rand(0.5, 1.4), ph: rand(0, Math.PI * 2), a: rand(0.5, 1),
    }));
  } else {
    const lvl = Math.min(5, kind.level);
    const T = RAIN_T[lvl], n = Math.max(2, Math.round(RAIN_N[lvl] * areaScale));
    cell.parts = Array.from({ length: n }, () => {
      const vy = (h / T) * rand(0.82, 1.25);
      return { x: rand(0, w), y: rand(-h, h), vy,
        len: Math.min(h * 0.7, Math.max(3, vy * 0.05)), a: rand(0.45, 1) };
    });
  }
}

function layoutFx(){
  if (!fx.canvas){
    fx.canvas = document.getElementById('fx');
    fx.ctx = fx.canvas.getContext('2d');
  }
  const g = gridEl.getBoundingClientRect();
  fx.w = g.width; fx.h = g.height;
  fx.dpr = Math.min(1.5, window.devicePixelRatio || 1);   // fog fill-rate: 1.5 is plenty
  Object.assign(fx.canvas.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
  fx.canvas.width = Math.round(g.width * fx.dpr);
  fx.canvas.height = Math.round(g.height * fx.dpr);
  fx.ctx.setTransform(fx.dpr, 0, 0, fx.dpr, 0, 0);
  // cap total mist strands so a fully-misty week doesn't tank the framerate
  let fogCount = 0;
  for (const cell of fx.cells) if (!cell.kind.snow && cell.kind.level === 1) fogCount++;
  fx.fogScale = fogCount ? Math.max(0.25, Math.min(1, FOG_BUDGET / (fogCount * 3.5))) : 1;
  for (const cell of fx.cells){
    const r = cell.el.getBoundingClientRect();
    cell.x = r.left - g.left; cell.y = r.top - g.top; cell.w = r.width; cell.h = r.height;
    buildParticles(cell);
  }
  startFx();
}

function drawCell(cell, dt, windTan){
  const ctx = fx.ctx;
  ctx.save();
  ctx.beginPath(); ctx.rect(cell.x, cell.y, cell.w, cell.h); ctx.clip();
  ctx.translate(cell.x, cell.y);
  if (cell.type === 'fog'){
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const step = Math.max(8, cell.w / 8);                     // wide soft lines tolerate coarse paths
    const halo = settings.fogOpacity >= 0.04;                // skip the faint halo pass when very transparent
    for (const p of cell.parts){
      p.ox += p.vx * dt + (Math.random() - 0.5) * 0.8;        // slide + Brownian jitter
      const ph = p.ph + fx.t * p.drift;
      const amp = cell.h * FOG_AMP * p.ampF;
      const a = settings.fogOpacity * p.aF;                    // live opacity slider
      const lw = p.lw * settings.fogWidth;                     // live line-width slider
      ctx.beginPath();
      for (let x = 0; x <= cell.w; x += step){
        const s = p.k * (x + p.ox);
        const y = p.by + amp * Math.sin(s + ph) + amp * 0.45 * Math.sin(s * 2.1 + ph * 1.4);
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      if (halo){
        ctx.lineWidth = lw * 2.4;                            // soft halo pass
        ctx.strokeStyle = `rgba(${cell.col},${(a * 0.4).toFixed(3)})`; ctx.stroke();
      }
      ctx.lineWidth = lw;                                     // core pass
      ctx.strokeStyle = `rgba(${cell.col},${a.toFixed(3)})`; ctx.stroke();
    }
  } else if (cell.type === 'snow'){
    for (const p of cell.parts){
      p.y += p.vy * dt;
      if (p.y - p.r > cell.h){ p.y = -p.r; p.bx = rand(0, cell.w); }
      const x = p.bx + Math.sin(fx.t * p.freq + p.ph) * p.amp;
      ctx.beginPath();
      ctx.fillStyle = `rgba(${cell.col},${(p.a * cell.alpha).toFixed(3)})`;
      ctx.arc(x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    const lvl = Math.min(5, cell.kind.level);
    ctx.lineCap = 'round';
    ctx.lineWidth = RAIN_LW[lvl];
    for (const p of cell.parts){
      const vx = p.vy * windTan;
      p.y += p.vy * dt; p.x += vx * dt;
      if (p.y - p.len > cell.h){ p.y = rand(-cell.h * 0.4, 0); p.x = rand(0, cell.w); }
      if (p.x < -2) p.x += cell.w + 4; else if (p.x > cell.w + 2) p.x -= cell.w + 4;
      const v = Math.hypot(vx, p.vy), ux = vx / v, uy = p.vy / v;
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${cell.col},${(p.a * cell.alpha).toFixed(3)})`;
      ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - ux * p.len, p.y - uy * p.len); ctx.stroke();
    }
  }
  ctx.restore();
}

function frame(now){
  const dt = Math.min(0.05, (now - fx.last) / 1000 || 0);
  fx.last = now; fx.t = now / 1000;
  fx.ctx.clearRect(0, 0, fx.w, fx.h);
  const windTan = Math.tan((12 + 8 * Math.sin(fx.t * 0.35)) * Math.PI / 180);
  for (const cell of fx.cells) drawCell(cell, dt, windTan);
  fx.raf = requestAnimationFrame(frame);
}

function startFx(){
  cancelAnimationFrame(fx.raf); fx.raf = 0;
  if (!fx.cells.length){ fx.ctx?.clearRect(0, 0, fx.w, fx.h); return; }
  if (reduceMotion.matches){             // one calm static frame, no loop
    fx.ctx.clearRect(0, 0, fx.w, fx.h);
    fx.t = 1; const windTan = Math.tan(14 * Math.PI / 180);
    for (const cell of fx.cells) drawCell(cell, 0, windTan);
    return;
  }
  fx.last = performance.now();
  fx.raf = requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden){ cancelAnimationFrame(fx.raf); fx.raf = 0; return; }
  startFx();
  if (days.length) placeNowLine();
  if (lastCoords && Date.now() - lastLoadedAt > 10 * 60 * 1000) load(lastCoords.lat, lastCoords.lon);
});

/* ---------- Tap-a-cell readout ---------- */
let tipTimer = null, selEl = null;
gridEl.addEventListener('click', e => {
  if (lpFired){ lpFired = false; return; }      // long-press opened the legend; don't also tip
  const c = e.target.closest('.cell');
  if (!c || c.classList.contains('empty')) return;
  showTip(+c.dataset.di, +c.dataset.h, c);
});

/* ---------- Color legend ---------- */
const legendEl = $('#legend');
let legendTimer = 0;
function gradFrom(fn, n){
  const stops = [];
  for (let i = 0; i < n; i++) stops.push(rgbStr(fn(i / (n - 1))));
  return `linear-gradient(to right, ${stops.join(',')})`;
}
function legendInfo(){
  if (settings.view === 'run')
    return { grad: gradFrom(t => runRGB(Math.round(t * 100)), 8), lo: 'avoid', hi: 'great' };
  const loF = 10, hiF = 100;
  const lab = f => `${Math.round(unitIsF() ? f : (f - 32) * 5 / 9)}${unitGlyph()}`;
  return { grad: gradFrom(t => tempRGB(loF + t * (hiF - loF)), 12), lo: lab(loF), hi: lab(hiF) };
}
function showLegend(){
  const info = legendInfo();
  legendEl.querySelector('.bar').style.background = info.grad;
  legendEl.querySelector('.lo').textContent = info.lo;
  legendEl.querySelector('.hi').textContent = info.hi;
  legendEl.hidden = false;
  clearTimeout(legendTimer);
  legendTimer = setTimeout(() => { legendEl.hidden = true; }, 4000);
}

// Long-press the grid to reveal the legend.
let lpTimer = 0, lpFired = false, lpX = 0, lpY = 0;
gridEl.addEventListener('pointerdown', e => {
  lpFired = false; lpX = e.clientX; lpY = e.clientY;
  lpTimer = setTimeout(() => { lpFired = true; showLegend(); }, 480);
});
gridEl.addEventListener('pointermove', e => {
  if (Math.abs(e.clientX - lpX) > 10 || Math.abs(e.clientY - lpY) > 10) clearTimeout(lpTimer);
});
gridEl.addEventListener('pointerup', () => clearTimeout(lpTimer));
gridEl.addEventListener('pointercancel', () => clearTimeout(lpTimer));
function showTip(di, h, el){
  const cell = days[di].cells[h];
  if (!cell) return;
  if (selEl) selEl.classList.remove('sel');
  selEl = el; el.classList.add('sel');

  const color = rgbStr(cellRGB(cell));
  const tF = Math.round(displayTemp(cell.c));
  const day = days[di];
  const bits = [
    `<span class="swatch" style="background:${color}"></span>`,
    `<b>${day.dow} ${fmtHourLong(h)}</b> · ${tF}${unitGlyph()}`,
  ];
  if (settings.view === 'run') bits.push(`· Run ${runIndex(cell)}`);
  const kind = precipKind(cell);
  bits.push(kind ? `· ${cell.pop|0}% · ${kind.label}` : '· dry');
  const head = place.name && place.name !== '—' ? `<span class="tip-place">${place.name}</span>` : '';
  let why = '';
  if (settings.view === 'run'){
    const rows = runBreakdown(cell)
      .map(r => `${r.label}: ${r.val} <b>${r.s == null ? '—' : r.s.toFixed(2)}</b>`)
      .join('<br>');
    why = `<span class="tip-why">${rows}<br>geomean → <b>${runIndex(cell)}</b></span>`;
  }
  tipEl.innerHTML = head + bits.join(' ') + why;
  tipEl.hidden = false;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(hideTip, 3200);
}
function hideTip(){
  tipEl.hidden = true;
  if (selEl){ selEl.classList.remove('sel'); selEl = null; }
}
document.addEventListener('click', e => {
  if (!e.target.closest('.cell') && !e.target.closest('.tip')) hideTip();
}, true);

/* ---------- Settings sheet ---------- */
function openSheet(){ syncSheet(); sheetEl.hidden = false; }
function closeSheet(){ sheetEl.hidden = true; }
sheetEl.addEventListener('click', e => { if (e.target.dataset.close !== undefined) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); hideTip(); } });

function syncSheet(){
  $('#appName').textContent = APP_NAME;
  $('#placeName').textContent = place.name;
  $('#placeSub').textContent = place.sub || '';
  document.querySelectorAll('.seg').forEach(seg => {
    const key = seg.dataset.setting;
    const val = String(settings[key]);
    seg.querySelectorAll('button').forEach(b =>
      b.classList.toggle('on', b.dataset.value === val));
  });
  document.querySelectorAll('[data-temp-only]').forEach(el =>
    el.style.display = settings.view === 'run' ? 'none' : '');
  $('#fogWidth').value = settings.fogWidth;
  $('#fogOpacity').value = settings.fogOpacity;
  $('#fogWidthVal').textContent = `×${settings.fogWidth.toFixed(1)}`;
  $('#fogOpacityVal').textContent = settings.fogOpacity.toFixed(3);
}
document.querySelectorAll('.seg').forEach(seg => {
  seg.addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    const key = seg.dataset.setting;
    let v = btn.dataset.value;
    if (v === 'true') v = true; else if (v === 'false') v = false;
    settings[key] = v;
    saveSettings();
    syncSheet();
    render();
    if (key === 'view' || key === 'palette' || key === 'unit') showLegend();
  });
});
// Mist sliders: draw loop reads settings live, so just update + persist (+ repaint if paused)
function bindSlider(id, key, fmt){
  $(`#${id}`).addEventListener('input', e => {
    settings[key] = parseFloat(e.target.value);
    $(`#${id}Val`).textContent = fmt(settings[key]);
    saveSettings();
    if (!fx.raf) startFx();          // keep the static (reduced-motion) frame current
  });
}
bindSlider('fogWidth', 'fogWidth', v => `×${v.toFixed(1)}`);
bindSlider('fogOpacity', 'fogOpacity', v => v.toFixed(3));

/* ---------- Run Index curve editor ---------- */
const SVGNS = 'http://www.w3.org/2000/svg';
const VBW = 320, VBH = 124, PADL = 26, PADR = 10, PADT = 10, PADB = 22;
const PLOTW = VBW - PADL - PADR, PLOTH = VBH - PADT - PADB;
const pX = (i, n) => PADL + i * PLOTW / (n - 1);
const pY = y => PADT + (1 - y) * PLOTH;
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

function buildRunEditor(){
  const host = $('#runDims'); host.innerHTML = '';
  for (const dim of RUN_DIMS){
    const n = dimPoints(dim);
    const curve = settings.runCurves[dim.key];
    const wrap = document.createElement('div'); wrap.className = 'rdim';
    const lab = document.createElement('div'); lab.className = 'rdim-label';
    lab.innerHTML = `${dim.label}${dim.unit ? ` <span>${dim.unit}</span>` : ''}`;
    wrap.appendChild(lab);
    const svg = svgEl('svg', { class: 'curve', viewBox: `0 0 ${VBW} ${VBH}` });

    TIERS.forEach(({ y, l }) => {
      svg.appendChild(svgEl('line', { class: l ? 'guide' : 'guide minor', x1: PADL, y1: pY(y), x2: VBW - PADR, y2: pY(y) }));
      if (l){ const lx = svgEl('text', { class: 'guide-l', x: 2, y: pY(y) + 2 }); lx.textContent = l; svg.appendChild(lx); }
    });
    for (let i = 0; i < n; i++){
      const tx = svgEl('text', { class: 'xl', x: pX(i, n), y: VBH - 6, 'text-anchor': 'middle' });
      tx.textContent = dim.ticks ? dim.ticks[i] : (dim.min + i * dim.step);
      svg.appendChild(tx);
    }
    const poly = svgEl('polyline', { class: 'curve-line' }); svg.appendChild(poly);
    const knobs = [];
    for (let i = 0; i < n; i++){ const k = svgEl('circle', { class: 'knob', r: 6, cx: pX(i, n) }); knobs.push(k); svg.appendChild(k); }
    wrap.appendChild(svg); host.appendChild(wrap);

    const redraw = () => {
      poly.setAttribute('points', curve.map((y, i) => `${pX(i, n)},${pY(y)}`).join(' '));
      knobs.forEach((k, i) => k.setAttribute('cy', pY(curve[i])));
    };
    redraw();

    const yFromEvent = ev => {
      const r = svg.getBoundingClientRect();
      const sy = (ev.clientY - r.top) * (VBH / r.height);
      return Math.max(0, Math.min(1, (PADT + PLOTH - sy) / PLOTH));
    };
    const nearestIndex = ev => {
      const r = svg.getBoundingClientRect();
      const sx = (ev.clientX - r.left) * (VBW / r.width);
      let bi = 0, bd = Infinity;
      for (let i = 0; i < n; i++){ const d = Math.abs(sx - pX(i, n)); if (d < bd){ bd = d; bi = i; } }
      return bi;
    };
    let active = -1;
    const set = ev => { curve[active] = snapTier(yFromEvent(ev)); redraw(); scheduleRunApply(); };
    const move = ev => { if (active < 0) return; set(ev); ev.preventDefault(); };
    const up = () => { if (active < 0) return; active = -1; saveSettings(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    svg.addEventListener('pointerdown', ev => {
      active = nearestIndex(ev); set(ev);
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      ev.preventDefault();
    });
  }
}

let runApplyRaf = 0;
function scheduleRunApply(){
  if (settings.view !== 'run' || runApplyRaf) return;
  runApplyRaf = requestAnimationFrame(() => { runApplyRaf = 0; recolorRun(); });
}
function recolorRun(){       // live recolor without rebuilding the grid DOM
  gridEl.querySelectorAll('.cell').forEach(el => {
    if (el.classList.contains('empty')) return;
    const cell = days[+el.dataset.di]?.cells[+el.dataset.h];
    if (!cell) return;
    const c = cellRGB(cell); el.style.background = rgbStr(c);
    const t = el.querySelector('.t');
    if (t){ t.style.color = effInk(+el.dataset.di, +el.dataset.h, c); t.textContent = cellNumber(cell) ?? ''; }
  });
}

const runEditorEl = $('#runEditor');
function openRunEditor(){
  if (settings.view !== 'run'){ settings.view = 'run'; saveSettings(); syncSheet(); render(); }
  buildRunEditor();
  sheetEl.hidden = true;
  runEditorEl.hidden = false;
}
function closeRunEditor(){ runEditorEl.hidden = true; }
$('#runEditBtn').addEventListener('click', openRunEditor);
$('#runBack').addEventListener('click', () => { closeRunEditor(); sheetEl.hidden = false; });
runEditorEl.addEventListener('click', e => { if (e.target.dataset.rclose !== undefined) closeRunEditor(); });
$('#runReset').addEventListener('click', () => {
  for (const d of RUN_DIMS) settings.runCurves[d.key] = d.def.map(snapTier);
  saveSettings(); buildRunEditor(); recolorRun();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !runEditorEl.hidden) closeRunEditor(); });

/* ---------- Location: geolocation + Open-Meteo geocoding ---------- */
function setPlace(name, sub){ place = { name, sub: sub || '' }; if (!sheetEl.hidden) syncSheet(); }

async function geocode(q){
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('search failed');
  const j = await r.json();
  return j.results || [];
}
const resultsEl = $('#searchResults');
$('#searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (!q) return;
  try {
    const res = await geocode(q);
    resultsEl.innerHTML = '';
    if (!res.length){ resultsEl.innerHTML = '<li>No matches</li>'; resultsEl.hidden = false; return; }
    res.forEach(r => {
      const li = document.createElement('li');
      const parts = [r.name, r.admin1, r.country_code].filter(Boolean);
      li.textContent = parts.join(', ');
      li.addEventListener('click', () => {
        settings.loc = { lat: r.latitude, lon: r.longitude, name: r.name, admin: [r.admin1, r.country_code].filter(Boolean).join(', ') };
        saveSettings();
        resultsEl.hidden = true; $('#searchInput').value = '';
        setPlace(r.name, settings.loc.admin);
        load(r.latitude, r.longitude);
      });
      resultsEl.appendChild(li);
    });
    resultsEl.hidden = false;
  } catch { resultsEl.innerHTML = '<li>Search error</li>'; resultsEl.hidden = false; }
});

$('#geoBtn').addEventListener('click', () => {
  settings.loc = null; saveSettings();
  setPlace('Locating…', '');
  locate();
});

function locate(){
  if (!('geolocation' in navigator)){ setPlace('Location unavailable', 'Search in settings'); return; }
  navigator.geolocation.getCurrentPosition(
    pos => { setPlace('Current location', ''); load(pos.coords.latitude, pos.coords.longitude); reverseName(pos.coords.latitude, pos.coords.longitude); },
    () => setPlace('Location blocked', 'Search in settings ⚙'),
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 }
  );
}
async function reverseName(lat, lon){
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?latitude=${lat}&longitude=${lon}&count=1&language=en&format=json`;
    const j = await (await fetch(url)).json();
    const r = j.results?.[0];
    if (r) setPlace(r.name, [r.admin1, r.country_code].filter(Boolean).join(', '));
  } catch { /* name is cosmetic; ignore */ }
}

/* ---------- Load orchestration (instant cache → fresh) ---------- */
function readCache(){
  try { return JSON.parse(localStorage.getItem(LS.cache) || 'null'); } catch { return null; }
}
function writeCache(lat, lon, json){
  localStorage.setItem(LS.cache, JSON.stringify({ lat, lon, t: Date.now(), json }));
}
function applyForecast(json){
  days = toDays(json);
  render();
  $('#updatedAt').textContent = 'Updated ' + new Date().toLocaleString([], { weekday:'short', hour:'numeric', minute:'2-digit' });
}

let loadSeq = 0, lastCoords = null, lastLoadedAt = 0;
async function load(lat, lon){
  const seq = ++loadSeq;
  lastCoords = { lat, lon };
  gridEl.classList.add('loading');
  try {
    const json = await fetchForecast(lat, lon);
    if (seq !== loadSeq) return;          // a newer load superseded this one
    lastLoadedAt = Date.now();
    writeCache(lat, lon, json);
    applyForecast(json);
  } catch (err) {
    if (!days.length) setPlace('Couldn’t load forecast', 'Tap ⚙ to retry');
    console.warn(err);
  } finally {
    if (seq === loadSeq) gridEl.classList.remove('loading');
  }
}

/* ---------- Boot ---------- */
function boot(){
  // 1) Instant paint from cache if we have anything to show.
  const cache = readCache();
  if (cache?.json){ applyForecast(cache.json); }
  else { days = placeholderDays(); render(); gridEl.classList.add('loading'); }

  // 2) URL deep-link wins: ?lat=&lon= or ?q=city (handy for sharing & headless testing).
  const params = new URLSearchParams(location.search);
  const qlat = parseFloat(params.get('lat')), qlon = parseFloat(params.get('lon')), qq = params.get('q');
  if (Number.isFinite(qlat) && Number.isFinite(qlon)){
    setPlace('Pinned location', `${qlat.toFixed(2)}, ${qlon.toFixed(2)}`);
    load(qlat, qlon); reverseName(qlat, qlon);
    return;
  }
  if (qq){
    setPlace('Locating…', '');
    geocode(qq).then(res => {
      const r = res[0];
      if (r){ setPlace(r.name, [r.admin1, r.country_code].filter(Boolean).join(', ')); load(r.latitude, r.longitude); }
      else locate();
    }).catch(locate);
    return;
  }

  // 3) Resolve location & fetch fresh.
  if (settings.loc){
    setPlace(settings.loc.name || 'Saved location', settings.loc.admin || '');
    load(settings.loc.lat, settings.loc.lon);
  } else {
    setPlace('Locating…', '');
    // If cache exists, refresh its coords first for instant continuity, then geolocate.
    if (cache?.lat != null) load(cache.lat, cache.lon);
    locate();
  }
}

// Re-render on orientation flip (1fr handles plain resizes for free).
let rT;
window.addEventListener('resize', () => {
  clearTimeout(rT);
  rT = setTimeout(() => {
    if ((isPortrait() ? 'p' : 'l') !== orientation) render();   // render() re-lays the canvas
    else layoutFx();                                            // same orientation: just re-measure
  }, 120);
});
window.addEventListener('orientationchange', () => setTimeout(render, 150));

// Live now-line: nudge it along every 30s (hour rollover lands on a fresh refetch).
setInterval(() => { if (days.length) placeNowLine(); }, 30000);
// Auto-refresh the forecast every 15 min so it never goes stale while left open.
setInterval(() => { if (lastCoords) load(lastCoords.lat, lastCoords.lon); }, 15 * 60 * 1000);

// Register service worker for offline / installable PWA (no-op on file://).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

boot();
