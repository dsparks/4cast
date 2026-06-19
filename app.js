const MOBILE_BP = 720;
const els = {
  place: document.getElementById('placeName'),
  updated: document.getElementById('updatedAt'),
  dayStrip: document.getElementById('dayStrip'),
  hoverReadout: document.getElementById('hoverReadout'),
  form: document.getElementById('searchForm'),
  input: document.getElementById('searchInput'),
  myLocBtn: document.getElementById('useMyLocation'),
  sunFacet: document.getElementById('facet-sun'),
  sunTable: document.getElementById('suntimes-table'),
  canvases: {
    temp: document.getElementById('chart-temp'),
    hcp: document.getElementById('chart-hcp'),
    precip: document.getElementById('chart-precip'),
    wind: document.getElementById('chart-wind'),
    runindex: document.getElementById('chart-runindex'),
    heatmap: document.getElementById('chart-heatmap'),
  },
};

let charts = {};
let lastSeries = null;
let crosshairTs = null;
let currentLat = null;
let currentLon = null;
let resizeBound = false;
let mobileFacetReady = false;
let lastMobile = null;
const sunCache = new Map();

const c2f = c => c == null ? null : c * 9 / 5 + 32;
const mm2in = mm => mm == null ? null : mm / 25.4;
const kmh2mph = kmh => kmh == null ? null : kmh * 0.621371;
const pa2inhg = pa => pa == null ? null : pa / 3386.389;
const fmtPct = v => v == null ? '—' : `${Math.round(v)}%`;
const fmtF = v => v == null ? '—' : `${Math.round(v)}°F`;
const fmtIn = v => v == null ? '—' : `${(Math.round(v * 100) / 100).toFixed(2)} in`;
const fmtMph = v => v == null ? '—' : `${Math.round(v)} mph`;
const fmtInHg = v => v == null ? '—' : `${(Math.round(v * 100) / 100).toFixed(2)} inHg`;
const fmtHourShort = h => h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
const getCSS = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const hexWithAlpha = (hex, a) => {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0,2),16)},${parseInt(h.slice(2,4),16)},${parseInt(h.slice(4,6),16)},${a})`;
};

function isMobile(){ return window.innerWidth <= MOBILE_BP; }
function dateISO(d){ return d.toISOString().slice(0,10); }
function parseClock(v){ const m=(v||'').match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i); return m ? m[1] : (v || '—'); }
function fmtDowHour(ms){ const d=new Date(ms); return `${d.toLocaleDateString([], {weekday:'short'})} ${d.toLocaleString([], {hour:'numeric'})}`; }

function setFacetExpanded(facet, open){
  facet.classList.toggle('is-open', open);
  const btn = facet.querySelector('.facet-toggle');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function syncMobileFacets(){
  const mobile = isMobile();
  const changed = lastMobile !== mobile;
  document.querySelectorAll('[data-mobile-collapsible="true"]').forEach(f => {
    const wantsOpen = (f.dataset.mobileDefault || 'open') !== 'closed';
    if (!mobileFacetReady || changed) setFacetExpanded(f, mobile ? wantsOpen : true);
    else if (!mobile) setFacetExpanded(f, true);
  });
  lastMobile = mobile;
  mobileFacetReady = true;
}
function initFacetToggles(){
  document.querySelectorAll('.facet-toggle').forEach(btn => btn.addEventListener('click', () => {
    const facet = btn.closest('.facet');
    if (facet) setFacetExpanded(facet, !facet.classList.contains('is-open'));
  }));
  syncMobileFacets();
}

function canvasHeight(key){
  const mobile = { temp:230, hcp:190, precip:150, wind:170, runindex:190, heatmap:300 };
  const desk = { temp:150, hcp:120, precip:95, wind:120, runindex:150, heatmap:260 };
  return (isMobile() ? mobile : desk)[key] || 140;
}
function sizeCanvas(key, canvas){
  canvas.height = canvasHeight(key);
  const w = Math.max(320, Math.floor((canvas.parentElement?.clientWidth || 920) - 20));
  canvas.width = canvas.id === 'chart-heatmap' ? Math.max(w, isMobile() ? 980 : 900) : w;
}
function sizeAllCanvases(){ Object.entries(els.canvases).forEach(([k,c]) => c && sizeCanvas(k,c)); }

function nearestIdx(axis, ts){
  let lo=0, hi=axis.length-1;
  while (hi-lo>1){ const mid=(lo+hi)>>1; if (axis[mid] < ts) lo=mid; else hi=mid; }
  return Math.abs(axis[lo]-ts) <= Math.abs(axis[hi]-ts) ? lo : hi;
}
function fetchJSON(url, accept='application/geo+json'){
  return fetch(url, {headers:{Accept:accept}}).then(r => { if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}
async function geocodeQuery(q){
  const zip=q.trim().match(/^\d{5}$/);
  if (zip){
    const j=await fetchJSON(`https://api.zippopotam.us/us/${zip[0]}`, 'application/json');
    const p=j.places?.[0]; if(!p) throw new Error('ZIP not found.');
    return { lat:+p.latitude, lon:+p.longitude, label:`${j['post code']} ${p['place name']}, ${j['state abbreviation']||p['state abbreviation']||''}` };
  }
  const url=`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(q)}&addressdetails=1&email=noreply@example.com`;
  const arr=await fetchJSON(url, 'application/json'); if(!arr.length) throw new Error('No results.');
  return { lat:+arr[0].lat, lon:+arr[0].lon, label:arr[0].display_name };
}
async function loadByLatLon(lat, lon){
  const points=await fetchJSON(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const p=points.properties;
  const place=(p.relativeLocation?.properties?.city||'') + (p.relativeLocation?.properties?.state ? `, ${p.relativeLocation.properties.state}` : '');
  const [daily,grid,hourly]=await Promise.all([fetchJSON(p.forecast), fetchJSON(p.forecastGridData), fetchJSON(p.forecastHourly)]);
  return { place: place || 'Selected location', daily, grid, hourly };
}

function parseValidTime(vt){
  const [startIso,dur]=vt.split('/'); const start=new Date(startIso); let hours=1;
  const m=dur?.match(/P(?:(\d+)D)?T?(?:(\d+)H)?/); const d=+(m?.[1]||0), h=+(m?.[2]||0);
  hours = d*24 + h || (d ? d*24 : 1); return {start, hours};
}
function expandHourly(values, convert){
  const map=new Map();
  values.forEach(v => {
    if (v.value == null || !v.validTime) return;
    const {start,hours}=parseValidTime(v.validTime); const out=convert ? convert(v.value) : v.value;
    for(let i=0;i<hours;i++) map.set(start.getTime()+i*3600*1000, out);
  });
  return map;
}
function mergeAxis(...maps){ const keys=new Set(); maps.forEach(m => m && m.forEach((_,k)=>keys.add(k))); return [...keys].sort((a,b)=>a-b); }
function at(map, ts){ return map && map.has(ts) ? map.get(ts) : null; }

function precipDescriptor(qpf, isSnow, snow){
  if (!qpf || qpf <= 0) return '';
  if (isSnow){ const rate=snow != null ? snow : qpf*10; return rate < 0.1 ? 'flurries' : rate < 0.3 ? 'light snow' : rate < 0.6 ? 'mod. snow' : 'heavy snow'; }
  return qpf < 0.02 ? 'misty' : qpf < 0.04 ? 'drizzle' : qpf < 0.06 ? 'light rain' : qpf < 0.10 ? 'moderate' : 'downpour';
}
function runningOptimalityIndex({T,DP,PoP,Pamt,Wind}){
  const tanh=Math.tanh; const pT=tanh(Math.abs(T-55)/15), pDP=tanh(Math.max(0,DP-55)/7), pCold=tanh(Math.max(0,40-T)/20 + Math.max(0,10-DP)/10);
  const core=PoP*(1-Math.exp(-(Pamt||0)/0.02)), extra=PoP*0.10*tanh(Math.max(0,(Pamt||0)-0.02)/0.03), pPrecip=Math.min(1, core+extra);
  const bWind=T>=65 ? tanh(Wind/12) : 0, pWind=T<=45 ? tanh(Math.max(0,Wind-5)/10) : 0;
  const pBase=0.50*pT + 0.30*pDP + 0.20*pCold, pWindAdj=pBase*(1-0.35*bWind) + 0.20*pWind, pFinal=Math.min(1, pWindAdj + 0.50*pPrecip);
  return 100*(1-pFinal);
}

function buildSeries(grid, hourly){
  const g=grid.properties;
  const temp=expandHourly(g.temperature.values, c2f), dew=expandHourly(g.dewpoint.values, c2f), rh=expandHourly(g.relativeHumidity.values), cloud=expandHourly(g.skyCover.values), pop=expandHourly(g.probabilityOfPrecipitation.values), qpf=expandHourly(g.quantitativePrecipitation.values, mm2in), snow=g.snowfallAmount?.values ? expandHourly(g.snowfallAmount.values, mm2in) : null, wind=expandHourly(g.windSpeed.values, kmh2mph), pressure=g.pressure?.values ? expandHourly(g.pressure.values, pa2inhg) : null;
  const tAxis=mergeAxis(temp,dew,rh,cloud,pop,qpf,snow||new Map(),wind,pressure||new Map());
  const nightBands=[]; const hp=hourly.properties?.periods || [];
  for(let i=0;i<hp.length;i++) if(hp[i].isDaytime===false){ const start=new Date(hp[i].startTime).getTime(); let end=start+3600*1000; while(i+1<hp.length && hp[i+1].isDaytime===false){ i++; end+=3600*1000; } nightBands.push([start,end]); }
  const dayDivs=tAxis.filter(ts => new Date(ts).getHours()===0), dateCenters=[]; for(let i=0;i<dayDivs.length-1;i++) dateCenters.push((dayDivs[i]+dayDivs[i+1])/2);
  const qpfByDay=new Map(); qpf.forEach((v,t)=>qpfByDay.set(new Date(t).toDateString(), (qpfByDay.get(new Date(t).toDateString())||0)+(v||0)));
  const labelStep=isMobile()?6:3, bottomTicks=tAxis.filter(ts=>{ const h=new Date(ts).getHours(); return h===0 || h%labelStep===0; });
  const series={ tAxis, nightBands, dayDivs, dateCenters, qpfByDay, bottomTicks, temperature:[], dewpoint:[], humidity:[], cloud:[], pop:[], qpfHourly:[], wind:[], pressure:pressure?[]:null, snowfall:snow?[]:null, runIndex:[] };
  tAxis.forEach(ts => {
    series.temperature.push(at(temp,ts)); series.dewpoint.push(at(dew,ts)); series.humidity.push(at(rh,ts)); series.cloud.push(at(cloud,ts)); series.pop.push(at(pop,ts)); series.qpfHourly.push(at(qpf,ts)); series.wind.push(at(wind,ts));
    if (pressure) series.pressure.push(at(pressure,ts)); if (snow) series.snowfall.push(at(snow,ts));
    series.runIndex.push(runningOptimalityIndex({ T:series.temperature.at(-1), DP:series.dewpoint.at(-1), PoP:(series.pop.at(-1)||0)/100, Pamt:series.qpfHourly.at(-1)||0, Wind:series.wind.at(-1)||0 }));
  });
  return series;
}

function forecastToEmoji(s){
  s=(s||'').toLowerCase();
  if (s.includes('thunder')) return '⛈️'; if (s.includes('snow')||s.includes('flurr')) return '❄️'; if (s.includes('sleet')) return '🌨️'; if (s.includes('rain')||s.includes('showers')||s.includes('shower')) return '🌧️'; if (s.includes('fog')||s.includes('haze')||s.includes('smoke')) return '🌫️'; if (s.includes('mostly sunny')) return '🌤️'; if (s.includes('partly sunny')||s.includes('partly cloudy')) return '🌥️'; if (s.includes('mostly cloudy')||s.includes('cloudy')) return '☁️'; if (s.includes('sunny')||s.includes('clear')) return '🌞'; return '🌡️';
}
function renderDayStrip(daily,qpfByDay){
  els.dayStrip.innerHTML='';
  const periods=(daily.properties?.periods||[]).filter(p=>p.isDaytime);
  periods.forEach(p => {
    const d=new Date(p.startTime), all=daily.properties?.periods||[], idx=all.findIndex(x=>x.number===p.number), low=idx>=0 && all[idx+1] && !all[idx+1].isDaytime ? all[idx+1].temperature : '—';
    const card=document.createElement('div'); card.className='day';
    card.innerHTML=`<div class="name">${d.toLocaleDateString([], {weekday:'short', month:'numeric', day:'numeric'})}</div><div class="emoji" aria-hidden="true">${forecastToEmoji(p.shortForecast)}</div><div class="temps"><span class="hi">${p.temperature}°F</span><span class="lo">${low}°F</span></div><div class="precip">${(qpfByDay.get(d.toDateString())||0).toFixed(2)} in</div>`;
    els.dayStrip.appendChild(card);
  });
}

function updateReadout(series, ts){
  if (!series?.tAxis?.length) return void(els.hoverReadout.textContent='');
  const i=nearestIdx(series.tAxis, ts), parts=[new Date(series.tAxis[i]).toLocaleString([], {weekday:'short', month:'numeric', day:'numeric', hour:'numeric'}), `Temp ${fmtF(series.temperature[i])}`, `Dew ${fmtF(series.dewpoint[i])}`, `RH ${fmtPct(series.humidity[i])}`, `Cloud ${fmtPct(series.cloud[i])}`, `PoP ${fmtPct(series.pop[i])}`, `Wind ${fmtMph(series.wind[i])}`];
  if (series.pressure) parts.push(`Press ${fmtInHg(series.pressure[i])}`); if (series.qpfHourly[i] != null) parts.push(`QPF ${fmtIn(series.qpfHourly[i])}`); if (series.runIndex[i] != null) parts.push(`RunIdx ${Math.round(series.runIndex[i])}`);
  els.hoverReadout.textContent=parts.join('  |  ');
}

const overlayPlugin = {
  id:'facetOverlay',
  beforeDatasetsDraw(chart,_args,opts){
    const {ctx,chartArea,scales:{x}}=chart; if(!x||!chartArea) return; ctx.save();
    ctx.fillStyle='rgba(125,125,125,0.08)'; (opts.nightBands||[]).forEach(([a,b]) => { const x0=x.getPixelForValue(a), x1=x.getPixelForValue(b); ctx.fillRect(Math.min(x0,x1), chartArea.top, Math.abs(x1-x0), chartArea.bottom-chartArea.top); });
    ctx.strokeStyle=opts.dayColor || '#c7ceda'; ctx.lineWidth=1; (opts.dayDivs||[]).forEach(ts => { const xp=x.getPixelForValue(ts); ctx.beginPath(); ctx.moveTo(xp, chartArea.top); ctx.lineTo(xp, chartArea.bottom); ctx.stroke(); });
    if (opts.showTop){ ctx.fillStyle='#6b7280'; ctx.font='12px system-ui, -apple-system, Segoe UI, Roboto, Arial'; ctx.textAlign='center'; ctx.textBaseline='top'; (opts.dateCenters||[]).forEach(ts => ctx.fillText(new Date(ts).toLocaleDateString([], {weekday:'short', month:'numeric', day:'numeric'}), x.getPixelForValue(ts), chartArea.top+2)); }
    ctx.restore();
  },
  afterDraw(chart,_args,opts){
    const {ctx,chartArea,scales:{x}}=chart; if(!x||!chartArea) return; ctx.save();
    ctx.fillStyle='#6b7280'; ctx.font=`${opts.bottomSize||11}px system-ui, -apple-system, Segoe UI, Roboto, Arial`; ctx.textAlign='center'; ctx.textBaseline='top';
    (opts.bottomTicks||[]).forEach(ts => { const d=new Date(ts), xp=x.getPixelForValue(ts), h=d.getHours(); if(h===0){ ctx.fillText(d.toLocaleDateString([], {weekday:'short'}), xp, chartArea.bottom+8); ctx.fillText(d.toLocaleDateString([], {month:'numeric', day:'numeric'}), xp, chartArea.bottom+20); } else ctx.fillText(fmtHourShort(h), xp, chartArea.bottom+14); });
    if (crosshairTs != null){ const xp=x.getPixelForValue(crosshairTs); ctx.strokeStyle='rgba(0,0,0,0.35)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(xp, chartArea.top); ctx.lineTo(xp, chartArea.bottom); ctx.stroke(); }
    ctx.restore();
  }
};

function makeFacetChart(canvas,{labels,datasets,nightBands,dayDivs,dateCenters,bottomTicks,showTop,tooltipLabel,scales}){
  return new Chart(canvas.getContext('2d'), {
    type:'line',
    data:{labels,datasets},
    options:{
      responsive:false,
      animation:false,
      maintainAspectRatio:false,
      interaction:{mode:'index', intersect:false},
      layout:{padding:{top:showTop?18:6, right:8, bottom:34, left:0}},
      plugins:{
        legend:{display:false},
        tooltip:{ enabled:true, backgroundColor:'rgba(255,255,255,0.96)', borderColor:'#e5e7eb', borderWidth:1, titleColor:'#111827', bodyColor:'#111827', displayColors:true, callbacks:{ title:items => fmtDowHour(labels[items[0].dataIndex]), label: tooltipLabel || (ctx => ` ${ctx.dataset.label}: ${ctx.raw}`), labelColor:ctx => { const c=ctx.dataset.borderColor||'#111827'; return {borderColor:c, backgroundColor:c}; } } },
        facetOverlay:{ nightBands, dayDivs, dateCenters, bottomTicks, showTop, bottomSize:isMobile()?10:11, dayColor:getCSS('--gridMid') }
      },
      scales
    },
    plugins:[overlayPlugin]
  });
}
function xScale(){ return { type:'time', time:{unit:'hour'}, ticks:{display:false}, grid:{color:getCSS('--grid')} }; }
function bindCrosshair(key){
  const chart=charts[key], onMove=ev => { const rect=chart.canvas.getBoundingClientRect(), clientX=ev.touches?.[0]?.clientX ?? ev.clientX, ts=chart.scales.x.getValueForPixel(clientX - rect.left); if(!ts) return; crosshairTs=ts; updateReadout(lastSeries, ts); Object.values(charts).forEach(c => c.update('none')); };
  chart.canvas.onmousemove = onMove;
  chart.canvas.ontouchmove = onMove;
  chart.canvas.ontouchstart = onMove;
}

async function fetchSunForDate(lat,lon,iso){
  const key=`${lat.toFixed(5)},${lon.toFixed(5)},${iso}`; if(sunCache.has(key)) return sunCache.get(key);
  const data=await fetchJSON(`https://api.sunrisesunset.io/json?lat=${lat}&lng=${lon}&date=${iso}`, 'application/json'); const result=data?.results||null; sunCache.set(key,result); return result;
}
function renderSunTable(days,lat,lon){
  els.sunTable.innerHTML=''; const wrap=document.createElement('div'); wrap.className='suntimes-grid';
  Promise.all(days.map(d => fetchSunForDate(lat,lon,dateISO(d)))).then(results => {
    results.forEach((r,i) => {
      const col=document.createElement('div'); col.className='suntimes-col';
      const head=document.createElement('div'); head.className='suntimes-header'; head.textContent=days[i].toLocaleDateString([], {weekday:'short', month:'numeric', day:'numeric'}); col.appendChild(head);
      [['dawn', parseClock(r?.dawn||r?.first_light), 'Dawn'], ['sunrise', parseClock(r?.sunrise), 'Sunrise'], ['solarnoon', parseClock(r?.solar_noon), 'Solar noon'], ['golden', parseClock(r?.golden_hour), 'Golden hour'], ['sunset', parseClock(r?.sunset), 'Sunset'], ['dusk', parseClock(r?.dusk||r?.last_light), 'Dusk']].forEach(([cls,txt,label]) => { const cell=document.createElement('div'); cell.className=`suntimes-cell ${cls}`; cell.innerHTML=`<small>${txt}</small>`; cell.title=`${label}: ${txt}`; col.appendChild(cell); });
      wrap.appendChild(col);
    });
    els.sunTable.appendChild(wrap);
  }).catch(() => { els.sunTable.textContent='Sun times unavailable.'; });
}

function lerp(a,b,t){ return Math.round(a+(b-a)*t); }
function tempToHex(t){
  const stops=[[0,[255,255,255]],[30,[123,44,191]],[40,[30,64,175]],[50,[6,182,212]],[60,[163,230,53]],[70,[250,204,21]],[80,[255,140,0]],[90,[220,38,38]],[110,[255,255,255]]];
  if (t == null || Number.isNaN(t)) return '#f3f4f6'; if (t <= stops[0][0]) return '#ffffff'; if (t >= stops.at(-1)[0]) return '#ffffff';
  for(let i=0;i<stops.length-1;i++) if(t>=stops[i][0] && t<stops[i+1][0]){ const [t0,c0]=stops[i], [t1,c1]=stops[i+1], f=(t-t0)/(t1-t0); return `#${[lerp(c0[0],c1[0],f), lerp(c0[1],c1[1],f), lerp(c0[2],c1[2],f)].map(v=>v.toString(16).padStart(2,'0')).join('')}`; }
  return '#f3f4f6';
}
function renderHeatmap(canvas,series){
  const ctx=canvas.getContext('2d'), W=canvas.width, H=canvas.height; ctx.clearRect(0,0,W,H);
  const left=76,right=6,top=18,bottom=18, innerW=W-left-right, innerH=H-top-bottom;
  const dayStarts=[]; series.tAxis.forEach((ts,i)=>{ const d=new Date(ts), m=new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); if(i===0 || m!==dayStarts.at(-1)) dayStarts.push(m); });
  const rows=Math.min(7,dayStarts.length), tileW=innerW/24, tileH=innerH/rows; ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);
  for(let r=0;r<rows;r++) for(let c=0;c<24;c++){ const ts=dayStarts[r]+c*3600*1000, i=nearestIdx(series.tAxis, ts), T=series.temperature[i], pop=(series.pop[i]||0)/100, x=left+c*tileW, y=top+r*tileH; ctx.fillStyle=tempToHex(T); ctx.fillRect(x,y,tileW,tileH); ctx.strokeStyle='rgba(17,24,39,0.25)'; ctx.lineWidth=1; ctx.strokeRect(Math.floor(x)+0.5, Math.floor(y)+0.5, Math.ceil(tileW)-1, Math.ceil(tileH)-1); if(pop>0){ ctx.fillStyle='rgba(0,0,0,0.8)'; ctx.fillRect(x, y+tileH-pop*tileH, tileW, pop*tileH); } if(T!=null){ ctx.fillStyle='rgba(17,17,17,0.85)'; ctx.font='11px system-ui, -apple-system, Segoe UI, Roboto, Arial'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(String(Math.round(T)), x+tileW/2, y+tileH*0.25); } }
  ctx.fillStyle='#6b7280'; ctx.font='10px system-ui, -apple-system, Segoe UI, Roboto, Arial'; ctx.textAlign='center'; ctx.textBaseline='top'; for(let c=0;c<24;c++){ const x=left+c*tileW+tileW/2, label=fmtHourShort(c); ctx.fillText(label,x,2); ctx.fillText(label,x,H-bottom+2); }
  ctx.fillStyle='#111827'; ctx.font='12px system-ui, -apple-system, Segoe UI, Roboto, Arial'; ctx.textAlign='right'; ctx.textBaseline='middle'; for(let r=0;r<rows;r++){ const d=new Date(dayStarts[r]); ctx.fillText(d.toLocaleDateString([], {weekday:'short', month:'numeric', day:'numeric'}), left-8, top+r*tileH+tileH/2); }
}
function ensureHeatmapTip(){ let tip=document.getElementById('heatmap-tip'); if(!tip){ tip=document.createElement('div'); tip.id='heatmap-tip'; document.body.appendChild(tip); } return tip; }
function placeTipNear(tip,x,y){ const rect=tip.getBoundingClientRect(); if(x+12+rect.width+8>window.innerWidth) x=Math.max(8, window.innerWidth-rect.width-8)-12; if(y+12+rect.height+8>window.innerHeight) y=Math.max(8, window.innerHeight-rect.height-8)-12; tip.style.left=`${x+12}px`; tip.style.top=`${y+12}px`; }
function renderHeatmapDOM(host,series){
  host.innerHTML=''; const dayStarts=[]; series.tAxis.forEach((ts,i)=>{ const d=new Date(ts), m=new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); if(i===0 || m!==dayStarts.at(-1)) dayStarts.push(m); }); const rows=Math.min(7,dayStarts.length);
  const table=document.createElement('table'); table.className='heatmap-table'; table.setAttribute('role','table'); table.setAttribute('aria-label','Hourly heatmap by day');
  const makeHead=scope => { const tr=document.createElement('tr'), blank=document.createElement('th'); blank.className='rowlabel'; blank.scope='col'; tr.appendChild(blank); for(let c=0;c<24;c++){ const th=document.createElement('th'); th.scope=scope; th.textContent=fmtHourShort(c); tr.appendChild(th); } return tr; };
  const thead=document.createElement('thead'); thead.appendChild(makeHead('col')); table.appendChild(thead); const tbody=document.createElement('tbody');
  for(let r=0;r<rows;r++){ const tr=document.createElement('tr'), d=new Date(dayStarts[r]), row=document.createElement('th'); row.className='rowlabel'; row.scope='row'; row.textContent=d.toLocaleDateString([], {weekday:'short', month:'numeric', day:'numeric'}); tr.appendChild(row);
    for(let c=0;c<24;c++){ const td=document.createElement('td'); td.className='hm-cell'; td.tabIndex=0; const ts=dayStarts[r]+c*3600*1000, i=nearestIdx(series.tAxis, ts), T=series.temperature[i], DP=series.dewpoint[i], PoP=series.pop[i]||0, qpf=series.qpfHourly[i]||0, snow=series.snowfall ? (series.snowfall[i]||0) : 0, desc=precipDescriptor(qpf, snow>0, snow), when=new Date(series.tAxis[i]).toLocaleString([], {weekday:'short', month:'numeric', day:'numeric', hour:'numeric'}); td.style.backgroundColor=tempToHex(T); td.style.setProperty('--popH', `${PoP|0}%`); td.title=`${when}  Temp ${fmtF(T)}  Dew ${fmtF(DP)}  PoP ${fmtPct(PoP)}${desc ? `  ${desc}` : ''}`; td.setAttribute('aria-label', td.title); td.innerHTML=`<div class="hm-cell-inner"><div class="hm-temp">${T==null ? '' : Math.round(T)}</div><div class="hm-occlude"></div></div>`;
      const openTip=(x,y)=>{ const tip=ensureHeatmapTip(); tip.innerHTML=`<b>${when}</b><br/>Temp ${fmtF(T)} · Dew ${fmtF(DP)} · PoP ${fmtPct(PoP)}${desc ? ` · ${desc}` : ''}`; tip.style.display='block'; placeTipNear(tip,x,y); els.hoverReadout.textContent=td.title; document.querySelectorAll('.hm-cell.is-selected').forEach(el=>el.classList.remove('is-selected')); td.classList.add('is-selected'); };
      td.addEventListener('click',ev=>{ openTip(ev.clientX,ev.clientY); ev.stopPropagation(); }); td.addEventListener('keydown',ev=>{ if(ev.key==='Enter'||ev.key===' '){ const rect=td.getBoundingClientRect(); openTip(rect.left+rect.width/2, rect.top+rect.height/2); ev.preventDefault(); ev.stopPropagation(); } });
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody); const tfoot=document.createElement('tfoot'); tfoot.appendChild(makeHead('col')); table.appendChild(tfoot); host.appendChild(table);
}

function destroyAllCharts(){ Object.values(charts).forEach(c=>{ try{ c.destroy(); }catch{} }); charts={}; }
function buildAllCharts(series){
  destroyAllCharts(); sizeAllCanvases(); syncMobileFacets(); renderHeatmapDOM(document.getElementById('heatmapDom'), series); renderHeatmap(els.canvases.heatmap, series);
  const labels=series.tAxis;
  charts.temp=makeFacetChart(els.canvases.temp, { labels, nightBands:series.nightBands, dayDivs:series.dayDivs, dateCenters:series.dateCenters, bottomTicks:series.bottomTicks, showTop:true, datasets:[{label:'Temperature (°F)', data:series.temperature, borderColor:getCSS('--temp'), backgroundColor:'transparent', tension:0.3, pointRadius:0, spanGaps:true, yAxisID:'y'},{label:'Dew Point (°F)', data:series.dewpoint, borderColor:getCSS('--dew'), backgroundColor:'transparent', tension:0.3, pointRadius:0, spanGaps:true, yAxisID:'y'}], scales:{ x:xScale(), y:{position:'left', ticks:{color:getCSS('--temp')}, grid:{color:getCSS('--grid')}} } });
  charts.hcp=makeFacetChart(els.canvases.hcp, { labels, nightBands:series.nightBands, dayDivs:series.dayDivs, bottomTicks:series.bottomTicks, datasets:[{label:'Humidity (%)', data:series.humidity, borderColor:getCSS('--humid'), backgroundColor:'transparent', tension:0.2, pointRadius:0, spanGaps:true, yAxisID:'y'},{label:'Cloud Cover (%)', data:series.cloud, borderColor:getCSS('--cloud'), backgroundColor:'transparent', tension:0.2, pointRadius:0, spanGaps:true, yAxisID:'y'},{label:'Chance of Precip (%)', data:series.pop, borderColor:getCSS('--pop'), backgroundColor:hexWithAlpha(getCSS('--pop'),0.25), tension:0.2, pointRadius:0, spanGaps:true, fill:true, yAxisID:'y'}], scales:{ x:xScale(), y:{position:'left', min:0, max:100, ticks:{color:'#6b7280'}, grid:{color:getCSS('--grid')}} } });
  charts.precip=makeFacetChart(els.canvases.precip, { labels, nightBands:series.nightBands, dayDivs:series.dayDivs, bottomTicks:series.bottomTicks, tooltipLabel:ctx => { const i=ctx.dataIndex, q=series.qpfHourly[i], snow=series.snowfall ? (series.snowfall[i]||0) : 0, desc=precipDescriptor(q||0, snow>0 || (series.temperature[i] != null && series.temperature[i] <= 34), snow), amount=q==null?'—':`${(Math.round(q*100)/100).toFixed(2)} in`; return desc ? ` ${amount} · ${desc}` : ` ${amount}`; }, datasets:[{label:'Hourly Liquid (in)', data:series.qpfHourly, type:'bar', backgroundColor:getCSS('--qpf'), borderWidth:0, yAxisID:'y'}], scales:{ x:xScale(), y:{position:'left', ticks:{color:getCSS('--qpf')}, grid:{color:getCSS('--grid')}} } });
  charts.wind=makeFacetChart(els.canvases.wind, { labels, nightBands:series.nightBands, dayDivs:series.dayDivs, bottomTicks:series.bottomTicks, datasets:[{label:'Wind (mph)', data:series.wind, borderColor:getCSS('--wind'), backgroundColor:'transparent', tension:0.2, pointRadius:isMobile()?0:2, spanGaps:true, yAxisID:'y'}], scales:{ x:xScale(), y:{position:'left', ticks:{color:getCSS('--wind')}, grid:{color:getCSS('--grid')}} } });
  charts.runindex=makeFacetChart(els.canvases.runindex, { labels, nightBands:series.nightBands, dayDivs:series.dayDivs, bottomTicks:series.bottomTicks, datasets:[{label:'Run Index (0–100)', data:series.runIndex, borderColor:getCSS('--run'), backgroundColor:'transparent', tension:0.3, pointRadius:0, spanGaps:true, yAxisID:'y'}], scales:{ x:xScale(), y:{position:'left', min:0, max:100, ticks:{color:getCSS('--run')}, grid:{color:getCSS('--grid')}} } });
  const days=series.dayDivs.length ? series.dayDivs.slice(0,7).map(ts=>new Date(ts)) : Array.from({length:7}, (_,i)=>{ const d=new Date(); d.setHours(0,0,0,0); return new Date(d.getTime()+i*24*3600*1000); });
  els.sunFacet.style.display=''; renderSunTable(days, currentLat, currentLon); Object.keys(charts).forEach(bindCrosshair);
  if (!resizeBound){ window.addEventListener('resize', () => { syncMobileFacets(); if(lastSeries) buildAllCharts(lastSeries); }); resizeBound=true; }
}

async function showForecast(lat, lon, labelOverride){
  currentLat=lat; currentLon=lon; els.place.textContent='Loading...'; els.updated.textContent='';
  const {place,daily,grid,hourly}=await loadByLatLon(lat,lon); els.place.textContent=labelOverride || place || `${lat.toFixed(3)}, ${lon.toFixed(3)}`; els.updated.textContent=`Updated ${new Date(grid.properties.updateTime || daily.properties.updated || new Date().toISOString()).toLocaleString()}`;
  const series=buildSeries(grid,hourly); lastSeries=series; renderDayStrip(daily, series.qpfByDay); buildAllCharts(series);
  if (series.tAxis.length){ crosshairTs=series.tAxis[0]; updateReadout(series, crosshairTs); Object.values(charts).forEach(c=>c.update('none')); }
}
async function useBrowserLocation(){
  if (!('geolocation' in navigator)) return void(els.updated.textContent='Geolocation not supported in this browser.');
  navigator.geolocation.getCurrentPosition(pos => showForecast(pos.coords.latitude, pos.coords.longitude), () => { els.updated.textContent='Geolocation failed or was blocked. Use the search box.'; }, {enableHighAccuracy:false, timeout:15000, maximumAge:300000});
}

document.addEventListener('click', ev => { const tip=document.getElementById('heatmap-tip'); if(!tip) return; if(!(ev.target?.closest && ev.target.closest('.hm-cell'))){ tip.style.display='none'; document.querySelectorAll('.hm-cell.is-selected').forEach(el=>el.classList.remove('is-selected')); } });
document.addEventListener('keydown', ev => { if(ev.key==='Escape'){ const tip=document.getElementById('heatmap-tip'); if(tip) tip.style.display='none'; document.querySelectorAll('.hm-cell.is-selected').forEach(el=>el.classList.remove('is-selected')); } });
els.form.addEventListener('submit', async ev => { ev.preventDefault(); const q=els.input.value.trim(); if(!q) return; try{ const g=await geocodeQuery(q); await showForecast(g.lat,g.lon,g.label); } catch(err){ els.updated.textContent=`Search error: ${err.message}`; } });
els.myLocBtn.addEventListener('click', () => useBrowserLocation());

initFacetToggles();
sizeAllCanvases();
useBrowserLocation();
