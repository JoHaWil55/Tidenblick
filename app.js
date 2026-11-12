(() => {
  'use strict';

  const API = 'https://gdi.bsh.de/ldproxy/rest/services/WaterLevelForecast/collections/waterlevelforecastdata/items/';
  const TZ = 'Europe/Berlin';
  const DEFAULT_STATION = 'leerort';
  const AREA_ORDER = ['Ems', 'Jade und Ostfriesland', 'Weser', 'Elbe', 'Nordfriesland bis Elbmündung (inkl. Helgoland)'];
  const AREA_SHORT = { 'Nordfriesland bis Elbmündung (inkl. Helgoland)': 'Nordfriesland & Helgoland' };
  const REFRESH_MS = 10 * 60 * 1000;

  const state = {
    stationId: DEFAULT_STATION,
    datum: 'PNP',
    rangeDays: 1,
    data: null,
    series: null,
    events: [],
    interpolated: false,
    loading: false,
    reqId: 0,
    wh: { preset: '', name: '', mode: 'dry', h: null, draft: 1.2, margin: 0.3, offset: 0, useFc: true },
  };

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* sandboxed preview */ } },
  };
  // Naive Zeitangaben (ohne Offset) sind BSH-Lokalzeit Europe/Berlin
  const tzOffsetMs = (date) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
  };
  const stations = (window.STATIONS || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const byId = Object.fromEntries(stations.map((s) => [s.id, s]));

  // ---------- Formatting ----------
  const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' });
  const fmtDayLong = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const fmtDateTime = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const fmtDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parseTs = (s) => {
    if (!s) return null;
    const str = String(s).trim().replace(' ', 'T');
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(str)) { const d = new Date(str); return isNaN(d) ? null : d; }
    let t = Date.parse(str + 'Z');
    if (isNaN(t)) return null;
    for (let i = 0; i < 2; i++) t = Date.parse(str + 'Z') - tzOffsetMs(new Date(t));
    return new Date(t);
  };
  const num = (v) => { if (v === null || v === undefined || v === '' || v === 'nan') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeRich = (s) => esc(s).replace(/&lt;(\/?)b&gt;/g, '<$1b>').replace(/&lt;br\s*\/?&gt;/g, '<br>');

  function toDatum(v) {
    if (v === null || v === undefined || !state.data) return null;
    const p = state.data.properties;
    if (state.datum === 'NHN') return v + (num(p.gaugezero_relative_to_nhn) ?? 0);
    if (state.datum === 'SKN') return v - (num(p.chartdatum_relative_to_gaugezero) ?? 0);
    return v;
  }
  const cm = (v, signed = false) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '–';
    const r = Math.round(v);
    return (signed && r > 0 ? '+' : '') + r.toLocaleString('de-DE');
  };
  const datumLabel = () => ({ PNP: 'PNP', NHN: 'NHN', SKN: 'SKN' }[state.datum]);
  function durationText(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'jetzt';
    const h = Math.floor(mins / 60), m = mins % 60;
    return h > 0 ? `in ${h} Std. ${m} Min.` : `in ${m} Min.`;
  }

  // ---------- Theme ----------
  const root = document.documentElement;
  let theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.setAttribute('data-theme', theme);
  $('themeBtn').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    setTiles();
    renderChart();
    updateMarkers();
  });
  const cssVar = (n) => getComputedStyle(root).getPropertyValue(n).trim();

  // ---------- Map ----------
  let map, tileLayer;
  const markers = {};
  function initMap() {
    if (!window.L) { $('map').innerHTML = '<div class="empty">Karte konnte nicht geladen werden.</div>'; return; }
    map = L.map('map', { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView([53.9, 8.4], 7);
    setTiles();
    stations.forEach((s) => {
      const m = L.circleMarker([s.lat, s.lon], { radius: 5, weight: 1.5 });
      m.bindTooltip(s.name, { direction: 'top', offset: [0, -4] });
      m.on('click', () => selectStation(s.id, { fromMap: true }));
      m.addTo(map);
      markers[s.id] = m;
    });
    const b = L.latLngBounds(stations.map((s) => [s.lat, s.lon]));
    map.fitBounds(b, { padding: [12, 12] });
    updateMarkers();
  }
  let labelLayer;
  function setTiles() {
    if (!map) return;
    if (tileLayer) map.removeLayer(tileLayer);
    if (labelLayer) map.removeLayer(labelLayer);
    const base = theme === 'dark' ? 'World_Dark_Gray' : 'World_Light_Gray';
    const url = (kind) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${base}_${kind}/MapServer/tile/{z}/{y}/{x}`;
    tileLayer = L.tileLayer(url('Base'), { maxZoom: 16, attribution: 'Karte: Esri, HERE, Garmin, &copy; OpenStreetMap-Mitwirkende' }).addTo(map);
    labelLayer = L.tileLayer(url('Reference'), { maxZoom: 16, pane: 'overlayPane', opacity: 0.85 }).addTo(map);
    Object.values(markers).forEach((mk) => mk.bringToFront());
  }
  function updateMarkers() {
    const prim = cssVar('--primary'), acc = cssVar('--accent'), surf = cssVar('--surface');
    Object.entries(markers).forEach(([id, m]) => {
      const sel = id === state.stationId;
      m.setStyle({ color: sel ? surf : prim, fillColor: sel ? acc : prim, fillOpacity: sel ? 1 : 0.55, radius: sel ? 8 : 5, weight: sel ? 2.5 : 1 });
      if (sel) m.bringToFront();
    });
  }

  // ---------- Station list ----------
  const FAV_KEY = 'tidenblick:favs';
  let favs = new Set((store.get(FAV_KEY) || []).filter((x) => byId[x]));
  const saveFavs = () => store.set(FAV_KEY, [...favs]);
  const stItemHtml = (s) => `<div class="st-item" role="option" tabindex="0" data-id="${s.id}" aria-selected="${s.id === state.stationId}">
    <span class="st-name">${esc(s.name)}</span><span class="st-right">${s.curve ? '' : '<span class="st-tag">nur HW/NW</span>'}<span class="st-fav${favs.has(s.id) ? ' active' : ''}" role="button" tabindex="-1" title="${favs.has(s.id) ? 'Favorit entfernen' : 'Als Favorit merken'}" aria-label="${favs.has(s.id) ? 'Favorit entfernen' : 'Als Favorit merken'}: ${esc(s.name)}">★</span></span></div>`;
  function renderList() {
    const q = $('search').value.trim().toLowerCase();
    const list = $('stationList');
    const all = stations.filter((s) => !q || s.name.toLowerCase().includes(q) || s.area.toLowerCase().includes(q));
    const favList = all.filter((s) => favs.has(s.id));
    const groups = {};
    all.filter((s) => !favs.has(s.id)).forEach((s) => { (groups[s.area] = groups[s.area] || []).push(s); });
    const order = AREA_ORDER.filter((a) => groups[a]).concat(Object.keys(groups).filter((a) => !AREA_ORDER.includes(a)));
    if (!order.length && !favList.length) { list.innerHTML = '<div class="empty">Kein Pegel gefunden. Versuche einen anderen Ortsnamen.</div>'; return; }
    list.innerHTML = (favList.length ? `<div class="group-title">Favoriten</div>${favList.map(stItemHtml).join('')}` : '') +
      order.map((a) => `
      <div class="group-title">${esc(AREA_SHORT[a] || a)}</div>
      ${groups[a].map(stItemHtml).join('')}
    `).join('');
  }
  $('search').addEventListener('input', () => { $('geoHint').textContent = ''; renderList(); });
  $('stationList').addEventListener('click', (e) => {
    const f = e.target.closest('.st-fav');
    if (f) {
      const id = f.closest('.st-item').dataset.id;
      if (favs.has(id)) favs.delete(id); else favs.add(id);
      saveFavs();
      renderList();
      return;
    }
    const b = e.target.closest('.st-item');
    if (b) selectStation(b.dataset.id);
  });
  $('stationList').addEventListener('keydown', (e) => {
    const items = [...$('stationList').querySelectorAll('.st-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      if (items[n]) items[n].focus();
    } else if (e.key === 'Home') { e.preventDefault(); if (items[0]) items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); if (items.length) items[items.length - 1].focus(); }
    else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { e.preventDefault(); selectStation(items[i].dataset.id); }
    else if (e.key === 'Escape' && $('pickerBody').classList.contains('open')) {
      $('pickerBody').classList.remove('open');
      $('pickerToggle').setAttribute('aria-expanded', 'false');
      $('pickerToggle').focus();
    }
  });
  document.querySelectorAll('[role="radiogroup"]').forEach((grp) => {
    grp.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      const btns = [...grp.querySelectorAll('[role="radio"]')];
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const n = (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
      btns[n].click();
      btns[n].focus();
    });
  });

  // ---------- Geolocation ----------
  $('nearBtn').addEventListener('click', () => {
    const hint = $('geoHint');
    if (!navigator.geolocation) { hint.textContent = 'Standortermittlung wird von diesem Browser nicht unterstützt.'; return; }
    $('nearBtn').classList.add('spinning');
    navigator.geolocation.getCurrentPosition((pos) => {
      $('nearBtn').classList.remove('spinning');
      const la = pos.coords.latitude, lo = pos.coords.longitude;
      let best = null, bd = Infinity;
      for (const s of stations) {
        const d = (s.lat - la) ** 2 + (((s.lon - lo) * Math.cos(la * Math.PI / 180))) ** 2;
        if (d < bd) { bd = d; best = s; }
      }
      if (!best) return;
      const km = Math.sqrt(bd) * 111.32;
      hint.textContent = `Nächster Pegel: ${best.name} (${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`})`;
      selectStation(best.id);
    }, () => {
      $('nearBtn').classList.remove('spinning');
      hint.textContent = 'Standort konnte nicht ermittelt werden (Berechtigung oder Funkloch).';
    }, { timeout: 10000 });
  });
  $('pickerToggle').addEventListener('click', () => {
    const body = $('pickerBody');
    const open = !body.classList.contains('open');
    body.classList.toggle('open', open);
    $('pickerToggle').setAttribute('aria-expanded', String(open));
    if (open && map) setTimeout(() => map.invalidateSize(), 50);
  });
  document.querySelectorAll('.quicknav button').forEach((b) => b.addEventListener('click', () => {
    const el = document.getElementById(b.dataset.target);
    if (!el) return;
    if (el.id === 'sidebar' && !$('pickerBody').classList.contains('open')) {
      $('pickerBody').classList.add('open');
      $('pickerToggle').setAttribute('aria-expanded', 'true');
      if (map) setTimeout(() => map.invalidateSize(), 50);
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  function selectStation(id, opts = {}) {
    if (!byId[id]) return;
    state.stationId = id;
    updateHash();
    renderList();
    updateMarkers();
    if (opts.fromMap) {
      const it = $('stationList').querySelector(`[data-id="${id}"]`);
      if (it) it.scrollIntoView({ block: 'nearest' });
    }
    $('pickerCurrent').textContent = byId[id].name;
    if (map && !opts.fromMap) map.panTo([byId[id].lat, byId[id].lon], { animate: true });
    if (window.matchMedia('(max-width: 860px)').matches) {
      $('pickerBody').classList.remove('open');
      $('pickerToggle').setAttribute('aria-expanded', 'false');
    }
    load();
  }

  // ---------- Controls ----------
  document.querySelectorAll('[data-datum]').forEach((b) => b.addEventListener('click', () => {
    state.datum = b.dataset.datum;
    document.querySelectorAll('[data-datum]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    updateHash();
    renderAll();
  }));
  document.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
    state.rangeDays = Number(b.dataset.range);
    document.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    updateHash();
    renderChart();
  }));
  $('refreshBtn').addEventListener('click', () => load());

  // ---------- Data ----------
  const CACHE_KEY = 'tidenblick:lastdata';
  const saveCache = (id, json) => store.set(CACHE_KEY, { id, ts: Date.now(), json });
  const loadCache = (id) => { const c = store.get(CACHE_KEY); return c && c.id === id && c.json ? c : null; };

  async function load() {
    const id = state.stationId;
    const req = ++state.reqId;
    state.loading = true;
    $('refreshBtn').classList.add('spinning');
    $('errorBox').hidden = true;
    if (!state.data || state.data.id !== id) showLoading(byId[id]);
    try {
      const res = await fetch(`${API}${encodeURIComponent(id)}?lang=de&f=json`, { headers: { Accept: 'application/geo+json, application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (req !== state.reqId) return;
      state.data = json;
      state.cacheTs = null;
      saveCache(id, json);
      prepare();
      renderAll();
    } catch (err) {
      if (req !== state.reqId) return;
      const cached = loadCache(id);
      if (cached) {
        state.data = cached.json;
        state.cacheTs = cached.ts;
        prepare();
        renderAll();
        $('errorBox').hidden = false;
        $('errorBox').innerHTML = `<div class="notice-title">Offline – letzte Daten vom ${fmtDateTime.format(new Date(cached.ts))} Uhr</div>Die BSH-Daten konnten gerade nicht aktualisiert werden (${esc(err.message)}). Es werden die zuletzt geladenen Werte angezeigt.`;
      } else {
        $('errorBox').hidden = false;
        $('errorBox').innerHTML = `<div class="notice-title">Daten nicht verfügbar</div>Die Daten des BSH konnten gerade nicht geladen werden (${esc(err.message)}). Bitte versuche es in einigen Minuten erneut.`;
      }
      if (!state.data || state.data.id !== id) clearSkeletons();
    } finally {
      if (req === state.reqId) { state.loading = false; $('refreshBtn').classList.remove('spinning'); }
    }
  }

  function showLoading(s) {
    $('stName').textContent = s ? s.name : 'Pegel wird geladen …';
    $('stArea').textContent = s ? (AREA_SHORT[s.area] || s.area) : '';
    $('stMeta').textContent = 'Daten werden vom BSH abgerufen …';
    $('stStatus').innerHTML = '';
    ['kpiNow', 'kpiHW', 'kpiNW', 'kpiRange'].forEach((k) => { $(k).classList.add('skel'); $(k).innerHTML = '&nbsp;'; });
    ['kpiNowSub', 'kpiHWSub', 'kpiNWSub', 'kpiRangeSub'].forEach((k) => { $(k).innerHTML = '&nbsp;'; });
    $('forecastText').hidden = true; $('infoText').hidden = true;
  }
  function clearSkeletons() {
    ['kpiNow', 'kpiHW', 'kpiNW', 'kpiRange'].forEach((k) => { $(k).classList.remove('skel'); $(k).textContent = '–'; });
    $('stMeta').textContent = '';
  }

  function bestForecast(e) {
    const off = num(e.forecast_value);
    if (off !== null) return { v: off, dev: e.forecast_deviation, src: 'amtlich', unc: num(e.forecast_uncertainty) };
    for (const r of ['r0', 'r1', 'r2', 'r3', 'r4', 'r5']) {
      const v = num(e[`mos_forecast_${r}_value`]);
      if (v !== null) return { v, dev: e[`mos_forecast_${r}_deviation`], src: `MOS ${r.toUpperCase()}`, unc: null };
    }
    return null;
  }

  function prepare() {
    const p = state.data.properties || {};
    state.events = (p.high_water_low_water || []).map((e) => ({
      t: parseTs(e.event_timestamp), type: e.event, pred: num(e.tidal_prediction_value), fc: bestForecast(e), raw: e,
    })).filter((e) => e.t && e.pred !== null).sort((a, b) => a.t - b.t);

    const curve = (p.curve || []).map((c) => ({
      t: parseTs(c.timestamp), pred: num(c.tidal_prediction), meas: num(c.measurement), fc: num(c.automated_curve_forecast),
    })).filter((c) => c.t).sort((a, b) => a.t - b.t);

    if (curve.length > 10) { state.series = curve; state.interpolated = false; }
    else { state.series = interpolateFromEvents(state.events); state.interpolated = true; }
  }

  // Cosinus-Interpolation zwischen Hoch- und Niedrigwasser (Näherung, wenn keine Kurve geliefert wird)
  function interpolateFromEvents(ev) {
    const out = [];
    for (let i = 0; i < ev.length - 1; i++) {
      const a = ev[i], b = ev[i + 1];
      const span = b.t - a.t;
      if (span <= 0 || span > 12 * 3600e3) continue;
      const fa = a.fc ? a.fc.v : null, fb = b.fc ? b.fc.v : null;
      for (let t = +a.t; t < +b.t; t += 10 * 60e3) {
        const x = (t - a.t) / span;
        const k = (1 - Math.cos(Math.PI * x)) / 2;
        out.push({
          t: new Date(t), pred: a.pred + (b.pred - a.pred) * k, meas: null,
          fc: fa !== null && fb !== null ? fa + (fb - fa) * k : null,
        });
      }
    }
    if (ev.length) { const l = ev[ev.length - 1]; out.push({ t: l.t, pred: l.pred, meas: null, fc: l.fc ? l.fc.v : null }); }
    return out;
  }

  function valueAt(field, t) {
    const s = state.series; if (!s || !s.length) return null;
    const i = d3.bisector((d) => d.t).left(s, t);
    const a = s[Math.max(0, i - 1)], b = s[Math.min(s.length - 1, i)];
    if (!a || !b || a[field] === null || b[field] === null) return (b && b[field]) ?? (a && a[field]) ?? null;
    if (+b.t === +a.t) return a[field];
    return a[field] + (b[field] - a[field]) * ((t - a.t) / (b.t - a.t));
  }

  // ---------- Render ----------
  function renderAll() {
    if (!state.data) return;
    renderHeader();
    renderKpis();
    renderChart();
    renderEvents();
    renderAstro();
    renderFacts();
    renderWh();
  }

  function warningClass(w) {
    if (!w || w === 'Wasserstandsvorhersage') return 'ok';
    if (/Sturmflut|Schweres|Sehr|^Niedrigwasser$/.test(w)) return 'danger';
    return 'warn';
  }
  function warningLabel(w) {
    if (!w || w === 'Wasserstandsvorhersage') return 'Keine Warnung';
    return w.replace('Erhoehter', 'Erhöhter');
  }

  function renderHeader() {
    const p = state.data.properties;
    const s = byId[state.stationId] || {};
    $('stName').textContent = p.gauge_label || s.name;
    $('stArea').textContent = `${AREA_SHORT[p.area] || p.area || ''} · ${p.state || ''}`;
    const ft = parseTs(p.forecast_timestamp), ct = parseTs(p.automated_curveforecast_timestamp);
    const parts = [];
    if (ft) parts.push(`Vorhersage vom ${fmtDateTime.format(ft)} Uhr`);
    if (ct) parts.push(`Kurve vom ${fmtDateTime.format(ct)} Uhr`);
    $('stMeta').textContent = parts.join(' · ');
    const w = p.automated_gauge_warning || p.official_warning_level_region;
    const hasOfficial = state.events.some((e) => e.fc && e.fc.src === 'amtlich');
    $('stStatus').innerHTML = `<span class="badge ${warningClass(w)}">${esc(warningLabel(w))}</span>` +
      (hasOfficial ? '<span class="badge">Amtlicher Vorhersagepegel</span>' : '');

    const fText = p.forecast_text && p.forecast_text.de;
    $('forecastText').hidden = !fText;
    if (fText) $('forecastText').innerHTML = `<div class="notice-title">Wasserstandsvorhersage des BSH</div>${safeRich(fText)}`;
    const iText = (p.information_text && p.information_text.de) || (p.forecast_text_additional && p.forecast_text_additional.de) || '';
    $('infoText').hidden = !iText;
    if (iText) $('infoText').innerHTML = `<div class="notice-title">Hinweis</div>${safeRich(iText)}`;
    if (p.copyright && p.copyright.de) $('copyright').textContent = `${p.copyright.de.replace(/^@/, '© ')} Lizenz: ${p.licence || 'CC BY 4.0'}.`;
  }

  function renderKpis() {
    const now = new Date();
    const unit = `<span class="unit">cm ${datumLabel()}</span>`;
    const s = state.series || [];
    const measured = s.filter((d) => d.meas !== null && d.t <= now);
    let cur, curSrc, curT;
    if (measured.length) { const last = measured[measured.length - 1]; cur = last.meas; curT = last.t; curSrc = 'gemessen'; }
    else { cur = valueAt('fc', now) ?? valueAt('pred', now); curT = now; curSrc = state.interpolated ? 'aus HW/NW berechnet' : 'berechnet'; }
    const earlier = (t) => {
      if (measured.length > 3) { const tgt = +t - 30 * 60e3; const prev = measured.slice().reverse().find((d) => +d.t <= tgt); return prev ? prev.meas : null; }
      return valueAt('fc', new Date(+t - 30 * 60e3)) ?? valueAt('pred', new Date(+t - 30 * 60e3));
    };
    const prev = earlier(curT);
    const set = (id, html) => { const el = $(id); el.classList.remove('skel'); el.innerHTML = html; };
    if (cur !== null && cur !== undefined) {
      const diff = prev !== null && prev !== undefined ? cur - prev : 0;
      const tr = Math.abs(diff) < 1.5 ? '<span>→ Stauwasser</span>' : diff > 0 ? '<span class="trend-up">↑ steigend</span>' : '<span class="trend-down">↓ fallend</span>';
      set('kpiNow', `${cm(toDatum(cur))}${unit}`);
      const pr = valueAt('pred', curT);
      const dv = pr !== null ? cur - pr : null;
      $('kpiNowSub').innerHTML = `${tr} · ${curSrc} ${fmtTime.format(curT)} Uhr${dv !== null && curSrc === 'gemessen' ? ` · ${cm(dv, true)} cm zur Vorausber.` : ''}`;
    } else { set('kpiNow', '–'); $('kpiNowSub').textContent = 'Keine aktuellen Werte'; }

    const nextOf = (type) => state.events.find((e) => e.type === type && e.t > now);
    [['HW', 'kpiHW', 'kpiHWSub'], ['NW', 'kpiNW', 'kpiNWSub']].forEach(([type, id, sub]) => {
      const e = nextOf(type);
      if (!e) { set(id, '–'); $(sub).textContent = 'Kein Termin verfügbar'; return; }
      set(id, `${fmtTime.format(e.t)}<span class="unit">Uhr</span>`);
      const h = e.fc ? e.fc.v : e.pred;
      $(sub).innerHTML = `${durationText(e.t - now)} · ${cm(toDatum(h))} cm${e.fc ? ` (${esc(e.fc.src === 'amtlich' ? 'Vorhersage' : 'MOS')})` : ''}`;
    });

    const nHW = nextOf('HW');
    if (nHW) {
      const idx = state.events.indexOf(nHW);
      const nw = state.events.slice(0, idx).reverse().find((e) => e.type === 'NW') || state.events.slice(idx).find((e) => e.type === 'NW');
      if (nw) {
        const lvl = (e) => (e.fc ? e.fc.v : e.pred);
        const range = lvl(nHW) - lvl(nw);
        const usesFc = !!(nHW.fc || nw.fc);
        const p = state.data.properties;
        const mean = num(p.mean_high_water) !== null && num(p.mean_low_water) !== null ? p.mean_high_water - p.mean_low_water : null;
        set('kpiRange', `${cm(range)}<span class="unit">cm</span>`);
        $('kpiRangeSub').textContent = `${fmtTime.format(nw.t)} NW → ${fmtTime.format(nHW.t)} HW${mean ? ` · ${cm(range - mean, true)} cm zum Mittel (${cm(mean)} cm)` : ''}${usesFc ? '' : ' · astronomisch'}`;
        return;
      }
    }
    set('kpiRange', '–'); $('kpiRangeSub').textContent = 'Nicht berechenbar';
  }

  // ---------- Chart ----------
  let resizeTimer;
  const ro = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderChart, 80); });
  ro.observe($('chartWrap'));

  function renderLegend(hasMeas, hasFc) {
    const items = [`<span><i style="border-color:var(--primary)"></i>Astronomische Vorausberechnung${state.interpolated ? ' (interpoliert)' : ''}</span>`];
    if (hasMeas) items.push('<span><i style="border-color:var(--text);border-top-width:2.5px"></i>Messung</span>');
    if (hasFc) items.push(`<span><i class="dash" style="border-color:var(--accent)"></i>${state.interpolated ? 'Vorhersage (aus HW/NW)' : 'Automatische Vorhersage'}</span>`);
    items.push('<span><i class="dash" style="border-color:var(--faint);border-top-width:1px"></i>MHW / MNW</span>');
    items.push('<span><i class="box" style="background:var(--night);outline:1px solid var(--line)"></i>Nacht</span>');
    if (whGaugeThreshold() !== null) {
      items.push('<span><i class="dash" style="border-color:var(--ok);border-top-width:1.5px"></i>Mindestwasserstand Wattenhoch</span>');
      items.push('<span><i class="box" style="background:var(--ok)"></i>Passage möglich</span>');
    }
    $('legend').innerHTML = items.join('');
  }

  function renderChart() {
    const svgEl = $('chart');
    const wrap = $('chartWrap');
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    if (!state.data || !state.series || !state.series.length || !window.d3) {
      $('chartNote').textContent = state.data ? 'Für diesen Pegel liegen keine Kurvendaten vor.' : '';
      return;
    }
    const W = Math.max(280, wrap.clientWidth);
    const H = W < 520 ? 260 : 340;
    const m = { t: 22, r: W < 520 ? 34 : 44, b: 28, l: W < 520 ? 38 : 46 };
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);

    const now = new Date();
    const s = state.series;
    const ext = d3.extent(s, (d) => d.t);
    let x0, x1;
    if (state.rangeDays === 1) { x0 = new Date(+now - 6 * 3600e3); x1 = new Date(+now + 18 * 3600e3); }
    else if (state.rangeDays === 3) { x0 = new Date(+now - 12 * 3600e3); x1 = new Date(+now + 60 * 3600e3); }
    else { x0 = ext[0]; x1 = ext[1]; }
    x0 = new Date(Math.max(+x0, +ext[0])); x1 = new Date(Math.min(+x1, +ext[1]));
    const vis = s.filter((d) => d.t >= x0 && d.t <= x1);
    const p = state.data.properties;
    const mhw = num(p.mean_high_water), mnw = num(p.mean_low_water);
    const hasMeas = vis.some((d) => d.meas !== null);
    const hasFc = vis.some((d) => d.fc !== null);
    renderLegend(hasMeas, hasFc);

    const vals = [];
    vis.forEach((d) => { ['pred', 'meas', 'fc'].forEach((k) => { if (d[k] !== null) vals.push(toDatum(d[k])); }); });
    if (mhw !== null) vals.push(toDatum(mhw));
    if (mnw !== null) vals.push(toDatum(mnw));
    const whLevel = whGaugeThreshold();
    if (whLevel !== null) vals.push(toDatum(whLevel));
    let [y0, y1] = d3.extent(vals);
    const pad = Math.max(20, (y1 - y0) * 0.12);
    y0 -= pad; y1 += pad;

    const x = d3.scaleTime().domain([x0, x1]).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([y0, y1]).nice().range([H - m.b, m.t]);
    const C = { prim: cssVar('--primary'), acc: cssVar('--accent'), text: cssVar('--text'), line: cssVar('--line'), faint: cssVar('--faint'), night: cssVar('--night'), surf: cssVar('--surface') };

    // Night shading
    const g0 = svg.append('g');
    if (window.SunCalc) {
      const days = d3.timeDay.range(d3.timeDay.offset(d3.timeDay.floor(x0), -1), d3.timeDay.offset(x1, 1));
      days.forEach((d) => {
        const mid = new Date(+d + 12 * 3600e3);
        const t1 = SunCalc.getTimes(mid, p.latitude, p.longitude);
        const t2 = SunCalc.getTimes(new Date(+mid + 24 * 3600e3), p.latitude, p.longitude);
        const a = Math.max(+t1.sunset, +x0), b = Math.min(+t2.sunrise, +x1);
        if (b > a) g0.append('rect').attr('x', x(a)).attr('y', m.t).attr('width', x(b) - x(a)).attr('height', H - m.t - m.b).attr('fill', C.night);
      });
    }

    // Grid
    const yt = y.ticks(H < 300 ? 5 : 6);
    svg.append('g').selectAll('line').data(yt).join('line')
      .attr('x1', m.l).attr('x2', W - m.r).attr('y1', y).attr('y2', y).attr('stroke', C.line).attr('stroke-width', 1);
    svg.append('g').selectAll('text').data(yt).join('text')
      .attr('x', m.l - 6).attr('y', (d) => y(d) + 3.5).attr('text-anchor', 'end').text((d) => d.toLocaleString('de-DE'));
    svg.append('text').attr('x', m.l - 6).attr('y', m.t - 9).attr('text-anchor', 'end').text(`cm ${datumLabel()}`);

    // X axis
    const span = x1 - x0;
    const xAxis = span <= 30 * 3600e3
      ? d3.axisBottom(x).ticks(d3.timeHour.every(W < 520 ? 6 : 3)).tickFormat((d) => fmtTime.format(d))
      : d3.axisBottom(x).ticks(d3.timeDay.every(1)).tickFormat((d) => fmtDay.format(d));
    const gx = svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(xAxis.tickSizeOuter(0));
    gx.select('.domain').attr('stroke', C.line);
    gx.selectAll('.tick line').attr('stroke', C.line);
    if (span > 30 * 3600e3) {
      svg.append('g').selectAll('line').data(d3.timeDay.range(x0, x1)).join('line')
        .attr('x1', x).attr('x2', x).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', C.line).attr('stroke-dasharray', '2 3');
    }

    // Wattenhoch: Passierfenster und Mindestwasserstand am Pegel
    if (whLevel !== null) {
      const C2 = cssVar('--ok');
      const gw = svg.append('g').attr('class', 'wh-layer');
      computeWindows().forEach((w) => {
        const a = Math.max(+w.start, +x0), b = Math.min(+w.end, +x1);
        if (b > a) gw.append('rect').attr('x', x(a)).attr('y', H - m.b - 6).attr('width', x(b) - x(a)).attr('height', 6).attr('fill', C2).attr('opacity', 0.85).attr('rx', 1.5);
        if (b > a) gw.append('rect').attr('x', x(a)).attr('y', m.t).attr('width', x(b) - x(a)).attr('height', H - m.t - m.b - 6).attr('fill', C2).attr('opacity', 0.07);
      });
      const yy = y(toDatum(whLevel));
      gw.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', yy).attr('y2', yy).attr('stroke', C2).attr('stroke-width', 1.5).attr('stroke-dasharray', '7 3');
      gw.append('text').attr('class', 'wh-label').attr('x', m.l + 6).attr('y', yy - 5).text(`${state.wh.name || 'Wattenhoch'}: min. ${cm(toDatum(whLevel))} cm am Pegel`);
    }

    // MHW/MNW
    [[mhw, 'MHW'], [mnw, 'MNW']].forEach(([v, l]) => {
      if (v === null) return;
      const yy = y(toDatum(v));
      svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', yy).attr('y2', yy).attr('stroke', C.faint).attr('stroke-dasharray', '4 4').attr('stroke-width', 1);
      svg.append('text').attr('x', W - m.r + 4).attr('y', yy + 3.5).text(l);
    });

    // Clip
    const clipId = 'clip-' + Math.random().toString(36).slice(2);
    svg.append('clipPath').attr('id', clipId).append('rect').attr('x', m.l).attr('y', 0).attr('width', W - m.l - m.r).attr('height', H);
    const gp = svg.append('g').attr('clip-path', `url(#${clipId})`);

    const gradId = 'grad-' + clipId;
    const grad = svg.append('defs').append('linearGradient').attr('id', gradId).attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1);
    grad.append('stop').attr('offset', '0%').attr('stop-color', C.prim).attr('stop-opacity', 0.22);
    grad.append('stop').attr('offset', '100%').attr('stop-color', C.prim).attr('stop-opacity', 0.02);

    const line = (k) => d3.line().defined((d) => d[k] !== null).x((d) => x(d.t)).y((d) => y(toDatum(d[k]))).curve(d3.curveMonotoneX);
    gp.append('path').datum(vis).attr('fill', `url(#${gradId})`)
      .attr('d', d3.area().defined((d) => d.pred !== null).x((d) => x(d.t)).y0(H - m.b).y1((d) => y(toDatum(d.pred))).curve(d3.curveMonotoneX));
    gp.append('path').datum(vis).attr('fill', 'none').attr('stroke', C.prim).attr('stroke-width', 1.75).attr('d', line('pred'));
    if (hasFc) gp.append('path').datum(vis).attr('fill', 'none').attr('stroke', C.acc).attr('stroke-width', 2).attr('stroke-dasharray', '5 4').attr('d', line('fc'));
    if (hasMeas) gp.append('path').datum(vis).attr('fill', 'none').attr('stroke', C.text).attr('stroke-width', 2.5).attr('stroke-linecap', 'round').attr('d', line('meas'));

    // Events
    const evs = state.events.filter((e) => e.t >= x0 && e.t <= x1);
    const showLabels = span <= 80 * 3600e3 && (W > 520 || span <= 30 * 3600e3);
    const ge = gp.append('g');
    evs.forEach((e) => {
      const v = toDatum(e.pred);
      ge.append('circle').attr('cx', x(e.t)).attr('cy', y(v)).attr('r', 3.5).attr('fill', C.surf).attr('stroke', e.type === 'HW' ? C.prim : C.acc).attr('stroke-width', 2);
      if (showLabels && x(e.t) > m.l + 26 && x(e.t) < W - m.r - 26) {
        const up = e.type === 'HW';
        ge.append('text').attr('class', 'ev-label').attr('x', x(e.t)).attr('y', y(v) + (up ? -9 : 16)).attr('text-anchor', 'middle')
          .text(`${e.type} ${fmtTime.format(e.t)}`);
      }
    });

    // Now marker
    if (now >= x0 && now <= x1) {
      svg.append('line').attr('x1', x(now)).attr('x2', x(now)).attr('y1', m.t - 4).attr('y2', H - m.b).attr('stroke', C.acc).attr('stroke-width', 1.5);
      svg.append('text').attr('class', 'now-label').attr('x', x(now)).attr('y', m.t - 8).attr('text-anchor', 'middle').text('jetzt');
    }

    // Hover
    const tt = $('tooltip');
    const hover = svg.append('g').style('display', 'none');
    const hl = hover.append('line').attr('y1', m.t).attr('y2', H - m.b).attr('stroke', C.faint).attr('stroke-width', 1);
    const hp = hover.append('circle').attr('r', 4).attr('fill', C.prim);
    const bis = d3.bisector((d) => d.t).center;
    svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', H - m.t - m.b)
      .attr('fill', 'transparent')
      .on('pointerenter', () => { hover.style('display', null); tt.hidden = false; })
      .on('pointerleave', () => { hover.style('display', 'none'); tt.hidden = true; })
      .on('pointermove', (ev) => {
        const [mx] = d3.pointer(ev);
        const d = vis[bis(vis, x.invert(mx))];
        if (!d) return;
        const xx = x(d.t);
        hl.attr('x1', xx).attr('x2', xx);
        hp.attr('cx', xx).attr('cy', y(toDatum(d.pred)));
        const rows = [`<div class="tt-time">${fmtDay.format(d.t)}, ${fmtTime.format(d.t)} Uhr</div>`,
          `<div class="tt-row">Vorausberechnung <b>${cm(toDatum(d.pred))} cm</b></div>`];
        if (d.meas !== null) rows.push(`<div class="tt-row">Messung <b>${cm(toDatum(d.meas))} cm</b></div>`);
        if (d.fc !== null) rows.push(`<div class="tt-row">Vorhersage <b>${cm(toDatum(d.fc))} cm</b></div>`);
        if (d.meas !== null && d.pred !== null) rows.push(`<div class="tt-row">Abweichung <b>${cm(d.meas - d.pred, true)} cm</b></div>`);
        else if (d.fc !== null && d.pred !== null) rows.push(`<div class="tt-row">Windstau erw. <b>${cm(d.fc - d.pred, true)} cm</b></div>`);
        const wd = whDepthFromPoint(d);
        if (wd !== null) {
          const need = (state.wh.draft + state.wh.margin) * 100;
          const at = state.wh.offset ? ` ${fmtTime.format(new Date(+d.t + state.wh.offset * 60e3))}` : '';
          rows.push(`<div class="tt-row tt-wh ${wd >= need ? 'ok' : 'no'}">Wattenhoch${at} <b>${wd < 0 ? `trocken (${m2(wd)} m)` : `${m2(wd)} m Wasser`}</b></div>`);
        }
        tt.innerHTML = rows.join('');
        const scale = wrap.clientWidth / W;
        const left = xx * scale;
        const tw = tt.offsetWidth || 180;
        tt.style.left = `${Math.min(Math.max(4, left + 14), wrap.clientWidth - tw - 4)}px`;
        tt.style.top = `${Math.max(0, m.t)}px`;
        if (left + 14 + tw > wrap.clientWidth) tt.style.left = `${Math.max(4, left - tw - 14)}px`;
      });

    $('chartSub').textContent = `Wasserstand in cm über ${{ PNP: 'Pegelnull (PNP)', NHN: 'Normalhöhennull (NHN)', SKN: 'Seekartennull (SKN)' }[state.datum]}`;
    $('chartNote').textContent = state.interpolated
      ? 'Für diesen Pegel liefert das BSH keine Zeitreihe. Die Kurve wird aus den Hoch- und Niedrigwasserzeiten näherungsweise berechnet.'
      : 'Fahre mit der Maus oder dem Finger über die Kurve, um einzelne Werte zu sehen.';
  }

  // ---------- Events table ----------
  function renderEvents() {
    const tb = $('events').querySelector('tbody');
    const now = new Date();
    const ev = state.events.filter((e) => +e.t > +now - 12 * 3600e3);
    if (!ev.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">Keine Hoch- und Niedrigwasserzeiten verfügbar.</td></tr>'; return; }
    const nextIdx = ev.findIndex((e) => e.t > now);
    let lastDay = '';
    const rows = [];
    ev.forEach((e, i) => {
      const key = fmtDayKey.format(e.t);
      if (key !== lastDay) { lastDay = key; rows.push(`<tr class="day"><td colspan="5" class="daycell">${esc(fmtDayLong.format(e.t))}</td></tr>`); }
      const fc = e.fc;
      let dev = '–';
      if (fc && fc.dev) {
        const n = parseFloat(String(fc.dev).replace('+/-', '').replace(',', '.').replace(' m', ''));
        const cls = n > 0 ? 'dev-pos' : n < 0 ? 'dev-neg' : '';
        dev = `<span class="${cls}">${esc(String(fc.dev).replace(' m', ''))} m</span>`;
      }
      rows.push(`<tr class="${e.t < now ? 'past' : ''} ${i === nextIdx ? 'next' : ''}">
        <td class="mono">${fmtTime.format(e.t)}</td>
        <td><span class="tide-pill ${e.type === 'HW' ? 'hw' : 'nw'}"><span class="long">${e.type === 'HW' ? 'Hochwasser' : 'Niedrigwasser'}</span><span class="short">${e.type}</span></span></td>
        <td class="num">${cm(toDatum(e.pred))}</td>
        <td class="num">${fc ? `${cm(toDatum(fc.v))}${fc.unc ? ` ±${cm(fc.unc)}` : ''}<span class="src">${esc(fc.src === 'amtlich' ? 'amtlich' : fc.src)}</span>` : '–'}</td>
        <td class="num">${dev}</td>
      </tr>`);
    });
    tb.innerHTML = rows.join('');
    $('eventsSub').textContent = `Astronomische Vorausberechnung und Vorhersage · Werte in cm ${datumLabel()}`;
  }

  // ---------- Astronomy ----------
  const PHASES = [
    [0.0333, 'Neumond'], [0.2167, 'Zunehmende Sichel'], [0.2833, 'Erstes Viertel'], [0.4667, 'Zunehmender Mond'],
    [0.5333, 'Vollmond'], [0.7167, 'Abnehmender Mond'], [0.7833, 'Letztes Viertel'], [0.9667, 'Abnehmende Sichel'], [1.01, 'Neumond'],
  ];
  function nextPhaseDate(target, from) {
    // Nächster Vollmond (Maximum der Beleuchtung) bzw. Neumond (Minimum), stündlich gesucht
    let t = +from;
    let prev = SunCalc.getMoonIllumination(new Date(t)).fraction;
    let dir = 0;
    for (let i = 0; i < 24 * 32; i++) {
      t += 3600e3;
      const f = SunCalc.getMoonIllumination(new Date(t)).fraction;
      const nd = f > prev ? 1 : f < prev ? -1 : dir;
      if (target === 0.5 && dir === 1 && nd === -1 && prev > 0.9) return new Date(t - 3600e3);
      if (target === 0 && dir === -1 && nd === 1 && prev < 0.1) return new Date(t - 3600e3);
      dir = nd; prev = f;
    }
    return null;
  }
  function renderAstro() {
    const p = state.data.properties;
    const el = $('astro');
    if (!window.SunCalc) { el.innerHTML = '<dt>Nicht verfügbar</dt><dd></dd>'; return; }
    const now = new Date();
    const t = SunCalc.getTimes(now, p.latitude, p.longitude);
    const mi = SunCalc.getMoonIllumination(now);
    const phaseName = PHASES.find(([lim]) => mi.phase < lim)[1];
    const full = nextPhaseDate(0.5, now), neu = nextPhaseDate(0, now);
    const syn = 29.53;
    const daysSince = (mi.phase % 0.5) * syn;
    let tide;
    if (daysSince <= 4 || daysSince >= 13.5) tide = 'Springtidenzeit – höherer Tidenhub zu erwarten';
    else if (daysSince >= 5.5 && daysSince <= 10) tide = 'Nipptidenzeit – geringerer Tidenhub zu erwarten';
    else tide = 'Übergang zwischen Spring- und Nipptide';
    const ft = (d) => (d && !isNaN(d) ? `${fmtTime.format(d)} Uhr` : '–');
    el.innerHTML = `
      <dt>Sonnenaufgang</dt><dd>${ft(t.sunrise)}</dd>
      <dt>Sonnenuntergang</dt><dd>${ft(t.sunset)}</dd>
      <dt>Tageslicht</dt><dd>${t.sunset && t.sunrise ? (() => { const mins = Math.round((t.sunset - t.sunrise) / 60000); return `${Math.floor(mins / 60)} Std. ${mins % 60} Min.`; })() : '–'}</dd>
      <dt>Mondphase</dt><dd class="text">${phaseName} (${Math.round(mi.fraction * 100)} %)</dd>
      <dt>Nächster Vollmond</dt><dd>${full ? fmtDay.format(full) : '–'}</dd>
      <dt>Nächster Neumond</dt><dd>${neu ? fmtDay.format(neu) : '–'}</dd>
      <div class="hint">${tide}. Springtiden treten etwa ein bis drei Tage nach Voll- und Neumond auf (astronomische Näherung).</div>`;
  }

  function renderFacts() {
    const p = state.data.properties;
    const gz = num(p.gaugezero_relative_to_nhn), cd = num(p.chartdatum_relative_to_gaugezero);
    const mhw = num(p.mean_high_water), mnw = num(p.mean_low_water);
    const rows = [];
    if (mhw !== null) rows.push(['Mittleres Hochwasser (MHW)', `${cm(toDatum(mhw))} cm ${datumLabel()}`]);
    if (mnw !== null) rows.push(['Mittleres Niedrigwasser (MNW)', `${cm(toDatum(mnw))} cm ${datumLabel()}`]);
    if (mhw !== null && mnw !== null) rows.push(['Mittlerer Tidenhub', `${cm(mhw - mnw)} cm`]);
    if (gz !== null) rows.push(['Pegelnull (PNP)', `${cm(gz, true)} cm NHN`]);
    if (cd !== null) rows.push(['Seekartennull (SKN)', `${cm(cd, true)} cm PNP`]);
    if (gz !== null && cd !== null) rows.push(['SKN bezogen auf NHN', `${cm(gz + cd, true)} cm NHN`]);
    if (p.operator_gauge_id && p.operator_gauge_id !== 'nan') rows.push(['Pegelnummer', esc(p.operator_gauge_id)]);
    rows.push(['Koordinaten', `${(+p.latitude).toFixed(3)}° N, ${(+p.longitude).toFixed(3)}° O`]);
    $('facts').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('refSub').textContent = `Bezugshöhen und Mittelwerte · Anzeige in ${datumLabel()}`;
    const links = [];
    if (p.bsh_url_waterlevel) links.push(`<a href="${esc(p.bsh_url_waterlevel)}" target="_blank" rel="noopener">BSH-Wasserstandsseite ↗</a>`);
    if (p.measurement_url) links.push(`<a href="${esc(p.measurement_url.trim())}" target="_blank" rel="noopener">Messwerte beim Betreiber ↗</a>`);
    links.push('<a href="https://gezeiten.bsh.de/" target="_blank" rel="noopener">BSH-Gezeitenvorausberechnung ↗</a>');
    $('links').innerHTML = links.join('');
  }

  // ---------- Wattenhoch-Passage ----------
  const m2 = (vcm) => (vcm === null || !Number.isFinite(vcm) ? '–' : (vcm / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const numIn = (id) => { const v = String($(id).value).replace(',', '.').trim(); if (v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function readWhForm() {
    const w = state.wh;
    w.name = $('whName').value.trim().slice(0, 40);
    const h = numIn('whHeight');
    w.h = h === null ? null : clamp(Math.abs(h), 0, 10);
    w.draft = clamp(numIn('whDraft') ?? 0, 0, 6);
    w.margin = clamp(numIn('whMargin') ?? 0, 0, 3);
    w.offset = Math.round(clamp(numIn('whOffset') ?? 0, -180, 180));
    w.useFc = $('whUseFc').checked;
  }
  function writeWhForm() {
    const w = state.wh;
    $('whPreset').value = w.preset || '';
    $('whName').value = w.name;
    $('whHeight').value = w.h === null ? '' : w.h;
    $('whDraft').value = w.draft;
    $('whMargin').value = w.margin;
    $('whOffset').value = w.offset;
    $('whUseFc').checked = w.useFc;
    document.querySelectorAll('[data-whmode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.whmode === w.mode)));
  }
  function readWhFromHash(q) {
    const w = state.wh;
    const n = (k) => { const v = q.get(k); if (v === null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
    if (q.get('bez') && ['PNP', 'NHN', 'SKN'].includes(q.get('bez'))) state.datum = q.get('bez');
    if ([1, 3, 7].includes(Number(q.get('zr')))) state.rangeDays = Number(q.get('zr'));
    if (q.get('fw') && PRESETS.some((x) => x.id === q.get('fw'))) w.preset = q.get('fw');
    if (q.get('wh')) w.name = q.get('wh').slice(0, 40);
    if (q.get('art') === 'tiefe') w.mode = 'depth';
    if (n('h') !== null) w.h = clamp(Math.abs(n('h')), 0, 10);
    if (n('tg') !== null) w.draft = clamp(n('tg'), 0, 6);
    if (n('hk') !== null) w.margin = clamp(n('hk'), 0, 3);
    if (n('vz') !== null) w.offset = Math.round(clamp(n('vz'), -180, 180));
    if (q.get('vh') === '0') w.useFc = false;
  }
  function updateHash() {
    const w = state.wh;
    const q = new URLSearchParams();
    if (state.datum !== 'PNP') q.set('bez', state.datum);
    if (state.rangeDays !== 1) q.set('zr', String(state.rangeDays));
    if (w.h !== null || w.preset) {
      if (w.preset) q.set('fw', w.preset);
      if (w.name) q.set('wh', w.name);
      if (w.mode === 'depth') q.set('art', 'tiefe');
      if (w.h !== null) q.set('h', w.h);
      q.set('tg', w.draft); q.set('hk', w.margin);
      if (w.offset) q.set('vz', w.offset);
      if (!w.useFc) q.set('vh', '0');
    }
    const qs = q.toString();
    const h = '#' + encodeURIComponent(state.stationId) + (qs ? '&' + qs : '');
    try { history.replaceState(null, '', h); } catch (_) { /* sandboxed preview */ }
    saveSettings();
  }

  // ---------- Gespeicherte Einstellungen ----------
  const SETTINGS_KEY = 'tidenblick:settings';
  function saveSettings() {
    store.set(SETTINGS_KEY, { station: state.stationId, datum: state.datum, range: state.rangeDays, wh: state.wh });
  }
  function loadSettings() {
    const s = store.get(SETTINGS_KEY);
    if (!s) return null;
    if (s.datum && ['PNP', 'NHN', 'SKN'].includes(s.datum)) state.datum = s.datum;
    if ([1, 3, 7].includes(s.range)) state.rangeDays = s.range;
    if (s.wh && typeof s.wh === 'object') {
      const w = state.wh;
      ['preset', 'name', 'mode', 'h', 'draft', 'margin', 'offset', 'useFc'].forEach((k) => { if (k in s.wh) w[k] = s.wh[k]; });
      if (!['dry', 'depth'].includes(w.mode)) w.mode = 'dry';
      if (!PRESETS.some((x) => x.id === w.preset)) w.preset = '';
      w.h = w.h === null || w.h === undefined ? null : clamp(Math.abs(Number(w.h) || 0), 0, 10);
      w.draft = clamp(Number(w.draft) || 0, 0, 6);
      w.margin = clamp(Number(w.margin) || 0, 0, 3);
      w.offset = Math.round(clamp(Number(w.offset) || 0, -180, 180));
      w.useFc = w.useFc !== false;
    }
    return s;
  }

  // Höhe des Wattenhochs über SKN in cm (trockenfallend positiv, Tiefe negativ)
  const whBedSKN = () => (state.wh.h === null ? null : (state.wh.mode === 'dry' ? 1 : -1) * state.wh.h * 100);
  const chartDatum = () => (state.data ? num(state.data.properties.chartdatum_relative_to_gaugezero) : null);
  // Mindestwasserstand am Bezugspegel in cm PNP
  function whGaugeThreshold() {
    const bed = whBedSKN(), cd = chartDatum();
    if (bed === null || cd === null || !state.data) return null;
    return bed + (state.wh.draft + state.wh.margin) * 100 + cd;
  }
  // Wasserstand am Pegel (cm PNP) für einen Kurvenpunkt: Messung > Vorhersage > Vorausberechnung
  function gaugeLevel(d) {
    if (d.meas !== null && d.t <= new Date()) return { v: d.meas, src: 'meas' };
    if (state.wh.useFc && d.fc !== null) return { v: d.fc, src: 'fc' };
    return d.pred !== null ? { v: d.pred, src: 'pred' } : null;
  }
  function whDepthFromPoint(d) {
    const bed = whBedSKN(), cd = chartDatum();
    if (bed === null || cd === null) return null;
    const g = gaugeLevel(d);
    return g ? g.v - cd - bed : null;
  }

  function computeWindows() {
    const s = state.series || [];
    const thr = whGaugeThreshold();
    if (thr === null || s.length < 2) return [];
    const off = state.wh.offset * 60e3;
    const pts = s.map((d) => ({ t: +d.t + off, g: gaugeLevel(d) })).filter((p) => p.g);
    const out = [];
    let cur = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], ok = p.g.v >= thr;
      const prev = pts[i - 1];
      const gap = prev && p.t - prev.t > 40 * 60e3;
      if (cur && (gap || !ok)) {
        let end = prev.t;
        if (!gap && !ok) end = prev.t + (p.t - prev.t) * ((prev.g.v - thr) / (prev.g.v - p.g.v));
        cur.end = new Date(end); cur.openEnd = false; out.push(cur); cur = null;
      }
      if (ok && !cur) {
        let start = p.t, openStart = i === 0;
        if (prev && !gap && prev.g.v < thr) start = prev.t + (p.t - prev.t) * ((thr - prev.g.v) / (p.g.v - prev.g.v));
        cur = { start: new Date(start), openStart, max: p.g.v, maxT: p.t, srcs: new Set() };
      }
      if (cur) { cur.srcs.add(p.g.src); if (p.g.v > cur.max) { cur.max = p.g.v; cur.maxT = p.t; } }
    }
    if (cur) { cur.end = new Date(pts[pts.length - 1].t); cur.openEnd = true; out.push(cur); }
    const cd = chartDatum(), bed = whBedSKN();
    out.forEach((w) => { w.maxDepth = w.max - cd - bed; w.maxT = new Date(w.maxT); });
    return out;
  }

  function darkness(w) {
    if (!window.SunCalc || !state.data) return '';
    const p = state.data.properties;
    const isDark = (t) => { const pos = SunCalc.getPosition(new Date(t), p.latitude, p.longitude); return pos.altitude < -0.833 * Math.PI / 180; };
    const n = 8; let dark = 0;
    for (let i = 0; i <= n; i++) if (isDark(+w.start + (w.end - w.start) * i / n)) dark++;
    if (dark === 0) return '';
    return dark === n + 1 ? 'bei Dunkelheit' : 'teils Dunkelheit';
  }
  const durText = (ms) => { const mins = Math.max(0, Math.round(ms / 60000)); const h = Math.floor(mins / 60), mm = mins % 60; return h ? `${h} Std. ${String(mm).padStart(2, '0')} Min.` : `${mm} Min.`; };

  function renderWh() {
    renderPresetInfo();
    const res = $('whResult'), wrap = $('whTableWrap'), tb = $('whTable').querySelector('tbody');
    const w = state.wh;
    const name = esc(w.name || 'Wattenhoch');
    if (w.h === null) {
      res.innerHTML = `<div class="wh-status neutral"><b>Kartenhöhe eintragen</b><span>Trage die Höhe des Wattenhochs laut aktueller Seekarte ein (z. B. 0,8 m trockenfallend). Danach erscheinen hier die Zeitfenster, in denen dein Boot mit ${m2((w.draft + w.margin) * 100)} m Wasserbedarf passieren kann.</span></div>`;
      wrap.hidden = true; return;
    }
    if (!state.data) { res.innerHTML = ''; wrap.hidden = true; return; }
    if (chartDatum() === null) {
      res.innerHTML = '<div class="wh-status bad"><b>Nicht berechenbar</b><span>Für diesen Pegel ist kein Seekartennull hinterlegt.</span></div>';
      wrap.hidden = true; return;
    }
    const now = new Date();
    const need = (w.draft + w.margin) * 100;
    const wins = computeWindows();
    const thr = whGaugeThreshold();
    const nowDepth = (() => {
      const s = state.series || []; if (!s.length) return null;
      const tg = new Date(+now - w.offset * 60e3);
      const i = d3.bisector((d) => d.t).center(s, tg);
      return s[i] && Math.abs(s[i].t - tg) < 40 * 60e3 ? whDepthFromPoint(s[i]) : null;
    })();
    const curW = wins.find((x) => x.start <= now && x.end >= now);
    const nextW = wins.find((x) => x.start > now);
    const depthLine = `Wassertiefe jetzt <b class="mono">${nowDepth !== null && nowDepth < 0 ? 'trocken' : `${m2(nowDepth)} m`}</b> · benötigt <b class="mono">${m2(need)} m</b> (${m2(w.draft * 100)} m Tiefgang + ${m2(w.margin * 100)} m) · am Pegel mind. <b class="mono">${cm(toDatum(thr))} cm ${datumLabel()}</b>`;
    let status;
    if (curW) status = `<div class="wh-status ok"><b>${name}: jetzt passierbar</b><span>${curW.openEnd ? 'bis zum Ende des Vorhersagezeitraums' : `noch bis ${fmtTime.format(curW.end)} Uhr (${durText(curW.end - now)})`}. ${depthLine}</span></div>`;
    else if (nextW) status = `<div class="wh-status warn"><b>${name}: derzeit nicht passierbar</b><span>Nächstes Fenster ${fmtDay.format(nextW.start)}, ${fmtTime.format(nextW.start)}–${fmtTime.format(nextW.end)} Uhr (${durationText(nextW.start - now)}). ${depthLine}</span></div>`;
    else status = `<div class="wh-status bad"><b>${name}: kein Fenster im Vorhersagezeitraum</b><span>Bei ${m2(need)} m Wasserbedarf reicht der Wasserstand in den nächsten Tagen nicht aus. ${depthLine}</span></div>`;
    res.innerHTML = status;

    const up = wins.filter((x) => x.end > now).slice(0, 16);
    if (!up.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    tb.innerHTML = up.map((x) => {
      const notes = [];
      const dk = darkness(x); if (dk) notes.push(dk);
      if (!x.srcs.has('fc') && !x.srcs.has('meas') && w.useFc && !state.interpolated) notes.push('nur Vorausber.');
      if (x.openStart || x.openEnd) notes.push('Rand des Datenzeitraums');
      if (x.maxDepth - need < 20) notes.push('knapp');
      const isNow = x.start <= now && x.end >= now;
      return `<tr class="${isNow ? 'next' : ''}">
        <td>${esc(fmtDay.format(x.start))}</td>
        <td class="mono">${fmtTime.format(x.start)}–${fmtTime.format(x.end)}${notes.length ? `<span class="wh-inline">${esc(notes.join(' · '))}</span>` : ''}</td>
        <td class="num">${durText(x.end - x.start)}</td>
        <td class="num">${m2(x.maxDepth)} m<span class="src">um ${fmtTime.format(x.maxT)} Uhr</span></td>
        <td class="wh-notes">${notes.length ? notes.map((t) => `<span class="wh-tag ${t === 'knapp' ? 'warn' : ''}">${esc(t)}</span>`).join(' ') : '<span class="wh-tag ok">Tageslicht</span>'}</td>
      </tr>`;
    }).join('');
  }


  // ---------- Bekannte Wattfahrwasser ----------
  const PRESETS = window.WATT_PRESETS || [];
  const PSRC = window.WATT_SOURCES || {};
  const presetById = Object.fromEntries(PRESETS.map((x) => [x.id, x]));
  (function fillPresets() {
    const sel = $('whPreset');
    const groups = [];
    PRESETS.forEach((x) => { if (!groups.includes(x.area)) groups.push(x.area); });
    groups.forEach((g) => {
      const og = document.createElement('optgroup'); og.label = g;
      PRESETS.filter((x) => x.area === g).forEach((x) => {
        const o = document.createElement('option'); o.value = x.id;
        o.textContent = `${x.name} · ${byId[x.gauge] ? byId[x.gauge].name : x.gauge}${x.off ? ` ${x.off > 0 ? '+' : '−'}${Math.abs(x.off)} Min.` : ''}`;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
  })();
  const srcLink = (k) => (PSRC[k] ? `<a href="${esc(PSRC[k].url)}" target="_blank" rel="noopener">${esc(PSRC[k].label)} ↗</a>` : '');
  const mFmt = (v) => v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  const monthsOld = (d) => {
    const [m, y] = String(d).split('.').map(Number);
    if (!m || !y) return null;
    const now = new Date();
    return (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
  };
  // Richtwerte als Höhe über SKN in m (positiv = trockenfallend)
  function presetValues(P) {
    const vals = [];
    if (P.official) vals.push({ key: 'off', h: P.official.h, title: 'Amtlich', desc: P.official.note, src: 'elwis' });
    if (P.ws !== undefined) vals.push({ key: 'ws', h: P.ws, title: 'Routenangabe', desc: 'SKN-Flachhöhe, ohne Datum', src: 'ws' });
    if (P.wsg) {
      const p = state.data && state.data.id === P.gauge ? state.data.properties : null;
      const mhw = p ? num(p.mean_high_water) : null, cd = p ? num(p.chartdatum_relative_to_gaugezero) : null;
      const desc = `Lotung ${mFmt(P.wsg.d)} m bei MHW, Stand ${P.wsg.date}${P.wsg.note ? ` · ${P.wsg.note}` : ''}`;
      if (mhw !== null && cd !== null) {
        const h = Math.round(((mhw - cd) / 100 - P.wsg.d) * 10) / 10;
        vals.push({ key: 'wsg', h, title: 'Aus Lotung', desc: `${desc}; umgerechnet mit MHW ${mFmt((mhw - cd) / 100)} m SKN am Bezugspegel`, src: 'wsg' });
      } else vals.push({ key: 'wsg', h: null, title: 'Aus Lotung', desc: `${desc}; Umrechnung nach dem Laden des Bezugspegels`, src: 'wsg' });
    }
    return vals;
  }
  const hText = (h) => (h >= 0 ? `${mFmt(h)} m trockenfallend` : `${mFmt(-h)} m Tiefe`);
  function renderPresetInfo() {
    const box = $('whPresetInfo'), w = state.wh, P = presetById[w.preset];
    if (!P) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    const g = byId[P.gauge];
    const cur = w.h === null ? null : (w.mode === 'dry' ? 1 : -1) * w.h;
    const vals = presetValues(P);
    const known = vals.filter((v) => v.h !== null);
    const maxH = known.length > 1 ? Math.max(...known.map((v) => v.h)) : null;
    const offTxt = P.off ? `${P.off > 0 ? '+' : '−'}${Math.abs(P.off)} Min.` : '0 Min.';
    let html = `<div class="pi-row">Bezugspegel <b>${esc(g ? g.name : P.gauge)}</b> · Zeitversatz <b class="mono">${offTxt}</b> — ${esc(P.offNote)}${P.offSrc ? ` (${srcLink(P.offSrc)})` : ''}</div>`;
    if (state.stationId !== P.gauge) html += `<div class="pi-row pi-warn">Gewählter Pegel weicht vom empfohlenen Bezugspegel ab. <button type="button" class="pi-take" data-pgauge="${esc(P.gauge)}">${esc(g ? g.name : P.gauge)} wählen</button></div>`;
    if (P.wsg && P.wsg.date) {
      const age = monthsOld(P.wsg.date);
      if (age !== null && age > 6) html += `<div class="pi-row pi-warn">Die hinterlegte Lotung stammt von ${esc(String(P.wsg.date))} und ist damit über ${age} Monate alt – bitte vor der Fahrt aktuelle Peilungen bzw. die Seekarte prüfen.</div>`;
    }
    if (w.offset !== P.off) html += `<div class="pi-row pi-warn">Zeitversatz geändert (empfohlen ${offTxt}).</div>`;
    if (vals.length) {
      html += '<div class="pi-row">Richtwerte für die Kartenhöhe – bitte mit der aktuellen Seekarte vergleichen und selbst übernehmen:</div><div class="pi-vals">';
      html += vals.map((v) => {
        const active = v.h !== null && cur !== null && Math.abs(v.h - cur) < 0.005;
        return `<div class="pi-val${active ? ' active' : ''}"><span><b>${v.title}:</b> <span class="mono">${v.h === null ? '–' : hText(v.h)}</span>${maxH !== null && v.h === maxH ? ' <span class="wh-tag warn">vorsichtigster Wert</span>' : ''}<br><span class="pi-foot">${esc(v.desc)} · ${srcLink(v.src)}</span></span>${v.h === null ? '' : active ? '<span class="wh-tag ok">übernommen</span>' : `<button type="button" class="pi-take" data-ph="${v.h}">Richtwert übernehmen</button>`}</div>`;
      }).join('') + '</div>';
    } else html += '<div class="pi-row">Für dieses Fahrwasser ist keine Höhe hinterlegt. Bitte die Kartenhöhe aus der aktuellen Seekarte eintragen.</div>';
    html += '<div class="pi-foot">Zeitversatz und Höhen sind Richtwerte ohne Gewähr. Gezeitenunterschiede können laut BSH-Gezeitenkalender bis zu 20 Min. abweichen; der Höhenunterschied zwischen Bezugspegel und Wattenhoch wird nicht korrigiert.</div>';
    box.innerHTML = html;
  }
  $('whPresetInfo').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.pgauge) { selectStation(b.dataset.pgauge); return; }
    if (b.dataset.ph !== undefined) {
      const h = Number(b.dataset.ph);
      state.wh.mode = h >= 0 ? 'dry' : 'depth'; state.wh.h = Math.abs(h);
      writeWhForm(); updateHash(); renderWh(); renderChart();
    }
  });
  $('whPreset').addEventListener('change', (e) => {
    e.stopPropagation();
    const w = state.wh, P = presetById[e.target.value];
    w.preset = P ? P.id : '';
    if (P) { w.name = P.name; w.offset = P.off; w.h = null; w.mode = 'dry'; }
    writeWhForm();
    if (P && state.stationId !== P.gauge) selectStation(P.gauge);
    else { updateHash(); renderWh(); renderChart(); }
  });

  let whTimer;
  $('whForm').addEventListener('input', (e) => {
    if (e.target.id === 'whPreset') return;
    clearTimeout(whTimer);
    whTimer = setTimeout(() => { readWhForm(); updateHash(); renderWh(); renderChart(); }, 200);
  });
  $('whForm').addEventListener('submit', (e) => e.preventDefault());
  document.querySelectorAll('[data-whmode]').forEach((b) => b.addEventListener('click', () => {
    state.wh.mode = b.dataset.whmode;
    document.querySelectorAll('[data-whmode]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    readWhForm(); updateHash(); renderWh(); renderChart();
  }));

  // ---------- Init ----------
  let initial = DEFAULT_STATION;
  const saved = loadSettings();
  try {
    const parts = (location.hash || '').slice(1).split('&');
    const h = decodeURIComponent(parts[0] || '');
    if (byId[h]) initial = h;
    else if (saved && saved.station && byId[saved.station]) initial = saved.station;
    readWhFromHash(new URLSearchParams(parts.slice(1).join('&')));
  } catch (_) { /* ignore */ }
  state.stationId = initial;
  writeWhForm();
  document.querySelectorAll('[data-datum]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.datum === state.datum)));
  document.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-checked', String(Number(x.dataset.range) === state.rangeDays)));
  renderList();
  initMap();
  $('pickerCurrent').textContent = byId[initial] ? byId[initial].name : '';
  if (map && byId[initial]) map.setView([byId[initial].lat, byId[initial].lon], 8);
  load();
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  setInterval(() => { if (state.data && !state.loading) { renderKpis(); renderWh(); } }, 60 * 1000);
})();
