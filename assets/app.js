/* Have Sick — static frontend. Data: data/waits.json (live, from scripts/collect.py) + data/places.json (OSM). */
(function () {
  'use strict';
  const STALE_MIN = 30;
  const REFRESH_MS = 120000;
  const CITIES = [
    ['Auckland CBD', -36.8485, 174.7633], ['Wellington', -41.2865, 174.7762], ['Christchurch', -43.5321, 172.6362],
    ['Hamilton', -37.7870, 175.2793], ['Tauranga', -37.6878, 176.1651], ['Dunedin', -45.8788, 170.5028],
    ['Whangārei', -35.7251, 174.3237], ['Napier', -39.4928, 176.9120], ['Hastings', -39.6381, 176.8492],
    ['Palmerston North', -40.3523, 175.6082], ['Nelson', -41.2706, 173.2840], ['Rotorua', -38.1368, 176.2497],
    ['New Plymouth', -39.0556, 174.0752], ['Queenstown', -45.0312, 168.6626], ['Invercargill', -46.4132, 168.3538],
    ['Gisborne', -38.6623, 178.0176], ['Whanganui', -39.9301, 175.0479], ['Timaru', -44.3970, 171.2550]
  ];
  const $ = (s) => document.querySelector(s);
  const S = { lang: localStorage.getItem('havesick.lang') || 'en', loc: null, live: [], osm: [], sources: {}, generatedAt: null, dataError: false, markers: null, userMarker: null };
  const t = (k) => (I18N[S.lang] && I18N[S.lang][k]) || I18N.en[k] || k;
  const now = () => (window.__HAVESICK_NOW__ ? new Date(window.__HAVESICK_NOW__) : new Date());

  // ---------- text size (percent of the browser/phone default, never px)
  const FONT_LEVELS = [100, 115, 130, 150, 175];
  function getFontLevel() { const i = parseInt(localStorage.getItem('havesick.fontLevel'), 10); return i >= 0 && i < FONT_LEVELS.length ? i : 0; }
  function setFontLevel(i) {
    i = Math.max(0, Math.min(FONT_LEVELS.length - 1, i));
    try { localStorage.setItem('havesick.fontLevel', String(i)); } catch (e) {}
    document.documentElement.style.fontSize = FONT_LEVELS[i] + '%';
    document.documentElement.dataset.fontLevel = i;
    updateFontUI();
    if (map) setTimeout(() => map.invalidateSize(), 50);
  }
  function updateFontUI() {
    const i = getFontLevel();
    const el = $('#fontLevel'); if (!el) return;
    el.textContent = FONT_LEVELS[i] + '%';
    el.setAttribute('aria-label', t('fontLevelLabel') + ' ' + FONT_LEVELS[i] + '%');
    $('#fontDown').disabled = i === 0; $('#fontUp').disabled = i === FONT_LEVELS.length - 1;
    $('#fontReset').setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
  }

  // ---------- helpers
  function distKm(a, b, c, d) {
    const p = Math.PI / 180, h = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtKm = (k) => (k < 1 ? Math.round(k * 1000) + ' m' : (k < 10 ? k.toFixed(1) : Math.round(k)) + ' km');
  function fmtMin(m) { if (m == null) return '—'; const h = Math.floor(m / 60), r = m % 60; return h ? `${h} h${r ? ' ' + r + ' min' : ''}` : `${r} min`; }
  function nzTime(iso) {
    try { return new Intl.DateTimeFormat(S.lang === 'zh' ? 'zh-HK' : 'en-NZ', { timeZone: 'Pacific/Auckland', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' }).format(new Date(iso)) + ' NZT'; } catch (e) { return iso; }
  }
  function ageMin(iso) { return iso ? (now() - new Date(iso)) / 60000 : Infinity; }
  function rel(iso) { const a = Math.max(0, Math.round(ageMin(iso))); return a < 1 ? t('justNow') : `${a} ${t('min')} ${t('ago')}`; }
  // Effective "data time" = when the source says it updated (if published) else when we fetched it.
  // Use the OLDER of the two so a stale upstream (e.g. Anglesea not updated for hours) is detected.
  function dataTime(p) {
    const a = p.fetched_at ? new Date(p.fetched_at) : null, b = p.source_updated_at ? new Date(p.source_updated_at) : null;
    if (a && b) return (a < b ? a : b).toISOString();
    return (a || b) ? (a || b).toISOString() : null;
  }
  function isStale(p) { return !!p.live && (p.stale || ageMin(dataTime(p)) > STALE_MIN); }
  function tier(p) { // 0 low .. 3 very high, 9 = no usable data
    if (!p.live || isStale(p) || !p.wait || p.wait.value == null || p.is_open === false) return 9;
    const v = p.wait.value;
    if (p.wait.type === 'minutes') return v <= 30 ? 0 : v <= 90 ? 1 : v <= 180 ? 2 : 3;
    return v <= 3 ? 0 : v <= 6 ? 1 : v <= 8 ? 2 : 3;
  }
  function openState(p) { // true / false / null
    if (typeof p.is_open === 'boolean') return p.is_open;
    if (p.hours && /^\s*24\/7\s*$/.test(p.hours)) return true;
    return null;
  }
  const gmaps = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=driving`;
  const amaps = (p) => `https://maps.apple.com/?daddr=${p.lat},${p.lon}&dirflg=d`;

  // ---------- data
  async function loadJSON(url) { const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error(url + ' HTTP ' + r.status); return r.json(); }
  async function loadWaits() {
    try {
      const w = await loadJSON('data/waits.json');
      S.live = (w.places || []).map((p) => Object.assign({}, p, { live: true }));
      S.sources = w.sources || {}; S.generatedAt = w.generated_at; S.dataError = false;
    } catch (e) { console.warn(e); S.dataError = true; }
  }
  async function loadPlaces() {
    try { const d = await loadJSON('data/places.json'); S.osm = d.places.map((p) => Object.assign({}, p, { live: false })); }
    catch (e) { console.warn(e); }
  }

  // ---------- render
  function applyI18n() {
    document.documentElement.lang = S.lang === 'zh' ? 'zh-Hant-HK' : 'en';
    document.querySelectorAll('[data-i18n]').forEach((el) => { const k = el.dataset.i18n; const v = t(k); if (/<b>/.test(v)) el.innerHTML = v; else el.textContent = v; });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
    $('#langBtn').textContent = S.lang === 'zh' ? 'English' : '繁中';
    updateFontUI();
  }
  function renderSources() {
    const ul = $('#sourceList'); ul.innerHTML = '';
    Object.entries(S.sources).forEach(([id, s]) => {
      const ok = s.status === 'ok';
      const li = document.createElement('li'); li.dataset.source = id;
      li.innerHTML = `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a> — <span class="${ok ? 'src-ok' : 'src-err'}">${ok ? t('srcOk') : t('srcErr')}</span>` +
        ` · ${t('updated')} ${s.source_updated_at ? nzTime(s.source_updated_at) : (s.fetched_at ? nzTime(s.fetched_at) : '—')}` +
        (!ok && s.last_success_at ? ` · ${t('lastOk')} ${nzTime(s.last_success_at)}` : '');
      ul.appendChild(li);
    });
    const li = document.createElement('li');
    li.innerHTML = `<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> — ${S.osm.length} locations (ODbL)`;
    ul.appendChild(li);
    $('#genAt').textContent = S.generatedAt ? nzTime(S.generatedAt) + ' (' + rel(S.generatedAt) + ')' : '—';
  }
  function renderBanner() {
    const b = $('#dataBanner');
    if (S.dataError) { b.hidden = false; b.textContent = t('dataError'); b.dataset.state = 'error'; }
    else if (ageMin(S.generatedAt) > STALE_MIN) { b.hidden = false; b.textContent = t('dataOld'); b.dataset.state = 'old'; }
    else { b.hidden = true; b.dataset.state = 'ok'; }
  }
  function candidates() {
    if (!S.loc) return [];
    const type = $('#typeSel').value, radius = +$('#radiusSel').value, sort = $('#sortSel').value;
    let all = S.live.concat(S.osm).map((p) => Object.assign(p, { d: distKm(S.loc.lat, S.loc.lon, p.lat, p.lon) }));
    all = all.filter((p) => {
      if (type === 'live') return p.live;
      if (type === 'urgent') return p.live || p.kind === 'urgent' || p.kind === 'ed';
      return true;
    }).filter((p) => p.d <= radius);
    const oRank = (p) => { const o = openState(p); return o === true ? 0 : o === null ? 1 : 2; };
    if (sort === 'near') all.sort((a, b) => a.d - b.d);
    else all.sort((a, b) => oRank(a) - oRank(b) || tier(a) - tier(b) ||
      (tier(a) < 9 && a.wait.type === b.wait.type ? (a.wait.value - b.wait.value) : 0) || a.d - b.d);
    return all.slice(0, 60);
  }
  function waitHTML(p) {
    if (!p.live) return `<div class="wait none"><span class="unit">${t('noLive')}</span></div>`;
    const tr = tier(p), w = p.wait || {};
    let main;
    if (p.is_open === false || w.value == null) {
      main = `<span class="val closedval">${t('closedNow')}</span>`;
    } else if (w.type === 'minutes') {
      main = `<span class="val" data-wait-minutes="${w.value}">${w.approx_hours ? '~' : ''}${fmtMin(w.value)}${w.plus ? '+' : ''}</span> <span class="unit">${t('minutesWait')}</span>`;
    } else {
      main = `<span class="val" data-busyness="${w.value}">${w.value}/10</span> <span class="unit">${t('busyness')}</span>` +
        `<div class="busybar"><i style="left:calc(${(w.value / 10) * 100}% - .125rem)"></i></div>`;
    }
    const extra = [];
    if (p.patients_waiting != null) extra.push(`${p.patients_waiting} ${t('patientsWaiting')}`);
    if (p.ed_wait_minutes) extra.push(`${t('edWait')} ${fmtMin(p.ed_wait_minutes)}`);
    const dt = dataTime(p);
    return `<div class="wait t${tr === 9 ? 'x' : tr}">${main}${extra.length ? `<div class="meta">${esc(extra.join(' · '))}</div>` : ''}` +
      `<div class="meta upd" data-updated="${esc(dt)}">${t('updated')} ${dt ? nzTime(dt) + ' (' + rel(dt) + ')' : '—'}</div>` +
      `<div class="stalewarn">${t('staleWarn')}${p.stale ? ' ' + t('sourceError') : ''}</div></div>`;
  }
  function render() {
    renderBanner(); renderSources();
    const list = $('#list'); list.innerHTML = '';
    const items = candidates();
    $('#empty').hidden = items.length > 0;
    $('#empty').textContent = S.loc ? t('noResults') : t('noLocation');
    items.forEach((p, i) => {
      const o = openState(p);
      const li = document.createElement('li');
      li.className = 'card' + (isStale(p) ? ' stale' : '');
      Object.assign(li.dataset, { id: p.id, live: p.live ? '1' : '0', dist: p.d.toFixed(3), lat: p.lat, lon: p.lon, rank: i + 1 });
      li.innerHTML = `<div class="top"><div><h3>${i + 1}. ${esc(p.name)}</h3><div class="meta">` +
        (p.live ? `<span class="badge live">${t('live')}</span>` : '') +
        `<span class="badge">${t('kind_' + p.kind)}</span>` +
        `<span class="badge ${o === true ? 'open' : o === false ? 'closed' : ''}">${o === true ? t('open') : o === false ? t('closed') : t('hoursUnknown')}</span>` +
        (p.hours ? ` ${esc(p.hours)}` : '') + (p.address ? ` · ${esc(p.address)}` : '') + (p.brand ? ` · ${esc(p.brand)}` : '') +
        `</div></div><div class="dist">${fmtKm(p.d)}</div></div>` + waitHTML(p) +
        `<div class="actions">` + (p.phone ? `<a class="tel" href="tel:${esc(String(p.phone).split(/[;,]| ext/)[0].replace(/[^\d+]/g, ''))}">${t('call')} ${esc(p.phone)}</a>` : '') +
        `<a class="nav gmaps" href="${gmaps(p)}" target="_blank" rel="noopener">${t('gmaps')}</a>` +
        `<a class="nav amaps" href="${amaps(p)}" target="_blank" rel="noopener">${t('amaps')}</a>` +
        (p.website ? `<a class="web" href="${esc(p.website)}" target="_blank" rel="noopener">${t('website')}</a>` : '') + `</div>`;
      list.appendChild(li);
    });
    renderMap(items);
  }

  // ---------- map
  let map;
  function initMap() {
    if (!window.L) { $('#map').textContent = 'Map unavailable'; return; }
    map = L.map('map', { zoomControl: true }).setView([-41.0, 174.0], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    S.markers = L.layerGroup().addTo(map);
    map.on('click', (e) => setLoc(e.latlng.lat, e.latlng.lng, 'map'));
  }
  function renderMap(items) {
    if (!map) return;
    S.markers.clearLayers();
    const colors = ['#2e7d32', '#ef8f00', '#e65100', '#c62828'];
    items.forEach((p, i) => {
      const tr = tier(p);
      L.circleMarker([p.lat, p.lon], { radius: p.live ? 9 : 6, color: '#fff', weight: 2, fillOpacity: .95, fillColor: tr === 9 ? '#90a4ae' : colors[tr] })
        .bindPopup(`<b>${i + 1}. ${esc(p.name)}</b><br>${fmtKm(p.d)}<br><a href="${gmaps(p)}" target="_blank">${t('gmaps')}</a> · <a href="${amaps(p)}" target="_blank">${t('amaps')}</a>`)
        .addTo(S.markers);
    });
    if (S.loc) {
      if (S.userMarker) S.userMarker.remove();
      S.userMarker = L.marker([S.loc.lat, S.loc.lon], { title: t('you') }).bindPopup(t('you')).addTo(map);
      const pts = [[S.loc.lat, S.loc.lon]].concat(items.slice(0, 8).map((p) => [p.lat, p.lon]));
      map.fitBounds(pts, { padding: [24, 24], maxZoom: 14 });
    }
  }

  // ---------- location
  function setStatus(msg, err) { const el = $('#locStatus'); el.textContent = msg; el.classList.toggle('err', !!err); }
  function setLoc(lat, lon, method, label) {
    S.loc = { lat, lon, method };
    setStatus(method === 'gps' ? t('locOk') : method === 'city' ? t('locCity') + label : t('locMap'));
    document.body.dataset.locMethod = method;
    render();
  }
  function locate() {
    if (!navigator.geolocation) return setStatus(t('locUnsupported'), true);
    setStatus(t('locating'));
    navigator.geolocation.getCurrentPosition(
      (pos) => setLoc(pos.coords.latitude, pos.coords.longitude, 'gps'),
      (err) => { setStatus(err.code === 1 ? t('locDenied') : t('locFail'), true); document.body.dataset.locMethod = 'failed'; $('#citySel').focus(); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  // ---------- boot
  async function boot() {
    const sel = $('#citySel');
    CITIES.forEach(([n, la, lo], i) => { const o = document.createElement('option'); o.value = i; o.textContent = n; sel.appendChild(o); });
    sel.addEventListener('change', () => { if (sel.value !== '') { const c = CITIES[+sel.value]; setLoc(c[1], c[2], 'city', c[0]); } });
    $('#locBtn').addEventListener('click', locate);
    ['#typeSel', '#radiusSel', '#sortSel'].forEach((s) => $(s).addEventListener('change', render));
    $('#langBtn').addEventListener('click', () => { S.lang = S.lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('havesick.lang', S.lang); applyI18n(); render(); if (S.loc) setLoc(S.loc.lat, S.loc.lon, S.loc.method, CITIES[+sel.value] ? CITIES[+sel.value][0] : ''); });
    $('#fontDown').addEventListener('click', () => setFontLevel(getFontLevel() - 1));
    $('#fontUp').addEventListener('click', () => setFontLevel(getFontLevel() + 1));
    $('#fontReset').addEventListener('click', () => setFontLevel(0));
    setFontLevel(getFontLevel());
    applyI18n(); initMap();
    await Promise.all([loadWaits(), loadPlaces()]);
    render();
    document.body.dataset.ready = '1';
    setInterval(async () => { await loadWaits(); render(); }, REFRESH_MS);
    const qs = new URLSearchParams(location.search);
    if (qs.get('nolocate') !== '1') locate();
  }
  window.HaveSick = { state: S, render, setLoc, setFontLevel, FONT_LEVELS, get map() { return map; } };
  boot();
})();
