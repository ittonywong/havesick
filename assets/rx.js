/* Have Sick — "Pharmacies & medicines" section.
   Data: data/pharmacies.json + data/medicines.json, built offline by scripts/build_pharmacy.py from official files.
   Nothing is sent anywhere: searches, location and favourites stay in this browser (localStorage only for the
   disclaimer version, language and favourites). The data files are only fetched AFTER the disclaimer is accepted. */
(function () {
  'use strict';
  const DISCLAIMER_VERSION = '2026-10-20.1';     // bump to ask every user again
  const K_DISC = 'havesick.rxDisclaimer', K_LANG = 'havesick.rxLang', K_FAV = 'havesick.rxFav';
  const LANGS = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'mi', 'ko'];
  const HTML_LANG = { en: 'en-NZ', 'zh-Hant': 'zh-Hant', 'zh-Hans': 'zh-Hans', ja: 'ja', mi: 'mi', ko: 'ko' };
  const HEALTHLINE = '0800 611 116';
  const URLS = {
    copay: 'https://www.healthnz.govt.nz/health-topics/tests-and-treatments/medicines/prescriptions',
    healthline: 'https://www.healthnz.govt.nz/online-phone-healthcare/healthline',
    medsafeSearch: 'https://www.medsafe.govt.nz/DbSearch/InfoSearch',
    cmiIndex: 'https://www.medsafe.govt.nz/Consumers/CMI/CMIIndex.htm',
    medsafeReg: 'https://www.medsafe.govt.nz/compliance/pharmacy-licence-register.asp',
    pharmac: 'https://schedule.pharmac.govt.nz/ScheduleOnline.php',
    ccby: 'https://creativecommons.org/licenses/by/4.0/',
    osm: 'https://www.openstreetmap.org/copyright'
  };
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  const HS = () => window.HaveSick;
  function defaultLang() {
    const saved = store.get(K_LANG);
    if (LANGS.includes(saved)) return saved;
    return store.get('havesick.lang') === 'zh' ? 'zh-Hant' : 'en';
  }
  const st = { view: 'clinics', mode: 'pharm', lang: defaultLang(), declined: false, P: null, M: null, idx: null,
    loading: null, sugg: [], active: -1, lastFocus: null, pharmKey: '', shown: 30, result: null, openD: new Set() };
  const T = (k, vars) => {
    let s = (RX_I18N[st.lang] && RX_I18N[st.lang][k]) || RX_I18N.en[k] || k;
    if (vars) Object.keys(vars).forEach((v) => { s = s.split('{' + v + '}').join(vars[v]); });
    return s;
  };
  function accepted() {
    try { const v = JSON.parse(store.get(K_DISC) || 'null'); return !!v && v.v === DISCLAIMER_VERSION; } catch (e) { return false; }
  }

  // ------------------------------------------------------------------ view switching
  function setView(view, opts) {
    st.view = view;
    document.body.dataset.view = view;
    $('#tabClinics').setAttribute('aria-pressed', view === 'clinics' ? 'true' : 'false');
    $('#tabRx').setAttribute('aria-pressed', view === 'rx' ? 'true' : 'false');
    $('#rx').hidden = view !== 'rx';
    document.body.dataset.rxmode = view === 'rx' && accepted() ? st.mode : '';
    if (view === 'rx') {
      if (location.hash !== '#pharmacy' && location.hash !== '#medicine') history.replaceState(null, '', '#pharmacy');
      renderShell();
      if (!accepted() && !st.declined && !(opts && opts.noPrompt)) openDialog(opts && opts.trigger);
    } else {
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      clearRxMap();
      HS() && HS().render();
    }
    setTimeout(() => HS() && HS().map && HS().map.invalidateSize(), 60);
  }

  // ------------------------------------------------------------------ disclaimer dialog
  function langSelect(id) {
    return `<select id="${id}" class="rx-langsel">` + LANGS.map((l) => `<option value="${l}"${l === st.lang ? ' selected' : ''} lang="${HTML_LANG[l]}">${esc(RX_I18N[l]._name)}</option>`).join('') + `</select>`;
  }
  function dialogHTML() {
    return `<div class="rx-dlg" role="dialog" aria-modal="true" aria-labelledby="rxDlgTitle" aria-describedby="rxDlgBody" lang="${HTML_LANG[st.lang]}">
      <div class="rx-dlg-top"><p class="rx-dlg-emerg"><a href="tel:111">🚨 111</a> · <a href="tel:0800611116">Healthline 0800 611 116</a></p><label class="rx-lang"><span>🌐 ${esc(T('lang'))}</span> ${langSelect('rxDlgLang')}</label></div>
      <h2 id="rxDlgTitle" tabindex="-1">${esc(T('dlgTitle'))}</h2>
      ${st.lang === 'mi' ? `<p class="rx-mi">${esc(T('selfNote'))}</p>` : ''}
      <div id="rxDlgBody"><ul>${['d1', 'd2', 'd3', 'd4', 'd5'].map((k) => `<li>${esc(T(k))}</li>`).join('')}</ul></div>
      <div class="rx-dlg-btns"><button type="button" id="rxAccept" class="primary">${esc(T('accept'))}</button>
      <button type="button" id="rxDecline" class="secondary">${esc(T('decline'))}</button></div>
      <p class="rx-dlg-ver">v${DISCLAIMER_VERSION}</p></div>`;
  }
  function others() { return Array.from(document.body.children).filter((el) => el.id !== 'rxOverlay' && el.tagName !== 'SCRIPT'); }
  function openDialog(trigger) {
    let ov = $('#rxOverlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'rxOverlay'; ov.className = 'rx-overlay'; document.body.appendChild(ov); }
    st.lastFocus = trigger || document.activeElement;
    ov.innerHTML = dialogHTML(); ov.hidden = false;
    others().forEach((el) => { el.inert = true; el.setAttribute('aria-hidden', 'true'); });
    document.documentElement.classList.add('rx-noscroll');
    ov.addEventListener('keydown', trap);
    $('#rxAccept').addEventListener('click', onAccept);
    $('#rxDecline').addEventListener('click', onDecline);
    $('#rxDlgLang').addEventListener('change', (e) => { setLang(e.target.value); ov.innerHTML = dialogHTML(); bindDlg(); $('#rxDlgLang').focus(); });
    $('#rxDlgTitle').focus();
  }
  function bindDlg() { $('#rxAccept').addEventListener('click', onAccept); $('#rxDecline').addEventListener('click', onDecline);
    $('#rxDlgLang').addEventListener('change', (e) => { setLang(e.target.value); $('#rxOverlay').innerHTML = dialogHTML(); bindDlg(); $('#rxDlgLang').focus(); }); }
  function focusables() { return Array.from($('#rxOverlay').querySelectorAll('select,button,a[href],[tabindex="0"]')).filter((el) => !el.disabled); }
  function trap(e) {
    if (e.key === 'Escape') { e.preventDefault(); onDecline(); return; }   // Esc closes WITHOUT accepting
    if (e.key !== 'Tab') return;
    const f = focusables(); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === $('#rxDlgTitle'))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function closeDialog() {
    const ov = $('#rxOverlay'); if (!ov) return;
    ov.hidden = true; ov.innerHTML = ''; ov.removeEventListener('keydown', trap);
    others().forEach((el) => { el.inert = false; el.removeAttribute('aria-hidden'); });
    document.documentElement.classList.remove('rx-noscroll');
    const back = st.lastFocus && document.contains(st.lastFocus) ? st.lastFocus : ($('#rxReopen') || $('#rxTitle') || $('#tabRx'));
    try { back.focus(); } catch (e) {}
  }
  function onAccept() {
    store.set(K_DISC, JSON.stringify({ v: DISCLAIMER_VERSION, at: new Date().toISOString() }));
    st.declined = false;
    document.body.dataset.rxmode = st.mode;
    renderShell(); loadData(); closeDialog();
    setTimeout(() => HS().map && HS().map.invalidateSize(), 60);
  }
  function onDecline() {
    st.declined = true;
    document.body.dataset.rxmode = '';
    renderShell(); clearRxMap(); closeDialog();
  }

  // ------------------------------------------------------------------ language
  function setLang(l) {
    if (!LANGS.includes(l)) return;
    st.lang = l; store.set(K_LANG, l); st.pharmKey = '';
    if (st.view === 'rx') renderShell();
  }

  // ------------------------------------------------------------------ data
  async function loadJSON(u) { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error(u + ' HTTP ' + r.status); return r.json(); }
  function loadData() {
    if (st.P && st.M) { renderAccepted(); return Promise.resolve(); }
    if (!st.loading) {
      st.loading = Promise.all([loadJSON('data/pharmacies.json'), loadJSON('data/medicines.json')])
        .then(([p, m]) => { st.P = p; st.M = m; buildIndex(); })
        .catch((e) => { console.warn(e); st.loadErr = true; st.loading = null; });
    }
    renderAccepted();
    return st.loading.then(() => { if (st.view === 'rx' && accepted()) renderAccepted(); });
  }

  // ------------------------------------------------------------------ shell
  function renderShell() {
    const rx = $('#rx'); if (!rx) return;
    rx.setAttribute('lang', HTML_LANG[st.lang]);
    $('#rxHead').innerHTML = `<h2 id="rxTitle" tabindex="-1">💊 ${esc(T('title'))}</h2><label class="rx-lang"><span>🌐 ${esc(T('lang'))}</span> ${langSelect('rxLang')}</label>`;
    $('#rxLang').addEventListener('change', (e) => setLang(e.target.value));
    $('#rxMi').hidden = st.lang !== 'mi'; $('#rxMi').textContent = st.lang === 'mi' ? T('selfNote') : '';
    const body = $('#rxBody');
    if (accepted()) { body.dataset.state = 'accepted'; renderAccepted(true); if (!st.P) loadData(); return; }
    clearRxMap();
    if (st.declined) {
      body.dataset.state = 'declined';
      body.innerHTML = `<div class="rx-declined card" role="status"><p class="rx-big">${esc(T('declineMsg'))}</p>
        <p><a class="pill-link" href="tel:0800611116">📞 ${esc(T('callHealthline'))}</a></p>
        <p><button type="button" id="rxReopen" class="secondary">${esc(T('reopen'))}</button></p></div>`;
      $('#rxReopen').addEventListener('click', (e) => { st.declined = false; openDialog(e.currentTarget); });
    } else {
      body.dataset.state = 'locked';
      body.innerHTML = `<div class="card rx-locked"><p>${esc(T('lockedMsg'))}</p><p><button type="button" id="rxOpenNotice" class="secondary">${esc(T('openNotice'))}</button></p></div>`;
      $('#rxOpenNotice').addEventListener('click', (e) => openDialog(e.currentTarget));
    }
  }
  function renderAccepted(full) {
    const body = $('#rxBody');
    if (!accepted() || st.view !== 'rx') return;
    if (full || !$('#rxPharm')) {
      body.innerHTML = `<p class="rx-privacy">🔒 ${esc(T('privacy'))}</p>
        <div class="rx-modes" role="group" aria-label="${esc(T('modeAria'))}">
          <button type="button" data-mode="pharm" aria-pressed="${st.mode === 'pharm'}">🏪 ${esc(T('modePharm'))}</button>
          <button type="button" data-mode="med" aria-pressed="${st.mode === 'med'}">💊 ${esc(T('modeMed'))}</button></div>
        <section id="rxPharm" aria-labelledby="rxPharmH"${st.mode === 'pharm' ? '' : ' hidden'}><h3 id="rxPharmH" class="vh">${esc(T('modePharm'))}</h3><div id="rxPharmBody"></div></section>
        <section id="rxMed" aria-labelledby="rxMedH"${st.mode === 'med' ? '' : ' hidden'}><h3 id="rxMedH" class="vh">${esc(T('modeMed'))}</h3><div id="rxMedBody"></div></section>
        <div id="rxSrc" class="rx-src"></div>`;
      body.querySelectorAll('.rx-modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
      st.pharmKey = ''; st.medBuilt = false;
    }
    if (st.loadErr && !st.P) { $('#rxPharmBody').innerHTML = $('#rxMedBody').innerHTML = `<p class="status err">${esc(T('loadErr'))}</p>`; return; }
    if (!st.P) { $('#rxPharmBody').innerHTML = $('#rxMedBody').innerHTML = `<p class="status">${esc(T('loading'))}</p>`; return; }
    renderSources();
    if (st.mode === 'pharm') renderPharm(); else clearRxMap();
    if (!st.medBuilt) buildMed();
  }
  function setMode(m) {
    st.mode = m; document.body.dataset.rxmode = m;
    history.replaceState(null, '', m === 'med' ? '#medicine' : '#pharmacy');
    $('#rxPharm').hidden = m !== 'pharm'; $('#rxMed').hidden = m !== 'med';
    document.querySelectorAll('.rx-modes button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === m ? 'true' : 'false'));
    st.pharmKey = '';
    if (m === 'pharm') { setTimeout(() => { HS().map && HS().map.invalidateSize(); renderPharm(); }, 30); }
    else clearRxMap();
  }
  function renderSources() {
    const P = st.P, M = st.M, ps = P.stats;
    $('#rxSrc').innerHTML = `<h3></h3>` +
      `<p>${esc(T('pharmSrc', { d: P.sources.medsafe_register_updated || '—', o: (P.sources.osm_base || '').slice(0, 10), m: ps.with_coordinates, n: ps.register_rows }))}
        <a href="${URLS.medsafeReg}" target="_blank" rel="noopener">Medsafe</a> · <a href="${URLS.osm}" target="_blank" rel="noopener">© OpenStreetMap contributors (ODbL)</a></p>` +
      `<p>${esc(T('medSrc', { e: M.sources.pharmac_edition, p: M.sources.pharmac_published, c: M.sources.cmi_index_revised || '—' }))}
        <a href="${URLS.pharmac}" target="_blank" rel="noopener">Pharmac — Pharmaceutical Schedule</a> · <a href="${URLS.ccby}" target="_blank" rel="noopener">CC BY 4.0</a> · <a href="${URLS.cmiIndex}" target="_blank" rel="noopener">Medsafe</a></p>` +
      `<p>${esc(T('copaySrc'))}: <a href="${URLS.copay}" target="_blank" rel="noopener">healthnz.govt.nz</a> · Healthline ${HEALTHLINE}: <a href="${URLS.healthline}" target="_blank" rel="noopener">healthnz.govt.nz</a></p>`;
    $('#rxSrc h3').textContent = { en: 'Data sources', 'zh-Hant': '資料來源', 'zh-Hans': '数据来源', ja: 'データの出典', mi: 'Ngā mātāpuna raraunga', ko: '자료 출처' }[st.lang];
  }

  // ------------------------------------------------------------------ pharmacies
  const favs = () => { try { return new Set(JSON.parse(store.get(K_FAV) || '[]')); } catch (e) { return new Set(); } };
  const pkey = (p) => p.n + '|' + p.a;
  const DAYS = {
    'zh-Hant': { Mo: '週一', Tu: '週二', We: '週三', Th: '週四', Fr: '週五', Sa: '週六', Su: '週日', PH: '公眾假期', off: '休息' },
    'zh-Hans': { Mo: '周一', Tu: '周二', We: '周三', Th: '周四', Fr: '周五', Sa: '周六', Su: '周日', PH: '公众假期', off: '休息' },
    ja: { Mo: '月', Tu: '火', We: '水', Th: '木', Fr: '金', Sa: '土', Su: '日', PH: '祝日', off: '休み' },
    ko: { Mo: '월', Tu: '화', We: '수', Th: '목', Fr: '금', Sa: '토', Su: '일', PH: '공휴일', off: '휴무' },
    mi: { Mo: 'Mane', Tu: 'Tūrei', We: 'Wenerei', Th: 'Tāite', Fr: 'Paraire', Sa: 'Hātarei', Su: 'Rātapu', PH: 'Hararei tūmatanui', off: 'kati' }
  };
  function fmtHours(h) {
    const d = DAYS[st.lang]; if (!d) return h;
    return h.replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH|off)\b/g, (m) => d[m]);
  }
  const telHref = (p) => 'tel:' + String(p).split(/[;,]| ext/)[0].replace(/[^\d+]/g, '');
  function card(p, dist) {
    const f = favs().has(pkey(p));
    const hasC = p.lat != null;
    const q = encodeURIComponent(p.n + ', ' + p.a);
    return `<li class="card rxp" data-has-hours="${p.h ? 1 : 0}" data-has-phone="${p.p ? 1 : 0}" data-has-coords="${hasC ? 1 : 0}" data-district="${esc(p.d)}"${dist != null ? ` data-dist="${dist.toFixed(3)}"` : ''}>
      <div class="top"><div><h4>${esc(p.n)}</h4><div class="meta">${esc(p.a)}</div>
      <div class="meta">${esc(T('district'))}: ${esc(p.d)} · ${esc(T('region'))}: ${esc(p.r)}${hasC ? '' : ' · <span class="badge">' + esc(T('noMap')) + '</span>'}</div></div>
      ${dist != null ? `<div class="dist">${HS().fmtKm(dist)}</div>` : ''}</div>
      <dl class="rx-dl"><div><dt>${esc(T('hours'))}</dt><dd class="hours"${p.h ? ` title="${esc(p.h)}"` : ''}>${p.h ? esc(fmtHours(p.h)) : `<span class="na">${esc(T('na'))}</span>`}</dd></div>
      <div><dt>${esc(T('phone'))}</dt><dd class="phone">${p.p ? `<a href="${esc(telHref(p.p))}">${esc(p.p)}</a>` : `<span class="na">${esc(T('na'))}</span>`}</dd></div></dl>
      <div class="actions">` +
      (hasC ? `<a class="nav" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}" target="_blank" rel="noopener">${esc(HS().t('gmaps'))}</a>
               <a class="nav" href="https://maps.apple.com/?daddr=${p.lat},${p.lon}" target="_blank" rel="noopener">${esc(HS().t('amaps'))}</a>`
            : `<a href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">${esc(T('mapSearch'))}</a>`) +
      `<button type="button" class="fav" data-key="${esc(pkey(p))}" aria-pressed="${f}" aria-label="${esc(T('favAria', { n: p.n }))}">${esc(f ? T('unfav') : T('fav'))}</button></div></li>`;
  }
  function bindFav(root) {
    root.querySelectorAll('button.fav').forEach((b) => b.addEventListener('click', () => {
      const s = favs(); const k = b.dataset.key; if (s.has(k)) s.delete(k); else s.add(k);
      store.set(K_FAV, JSON.stringify(Array.from(s))); st.pharmKey = ''; renderPharm(true);
      const again = Array.from(document.querySelectorAll('button.fav')).find((x) => x.dataset.key === k); if (again) again.focus();
    }));
  }
  function renderPharm(force) {
    if (!st.P || st.view !== 'rx' || st.mode !== 'pharm' || !accepted()) return;
    const S = HS().state, radius = +$('#radiusSel').value;
    const key = [S.loc && S.loc.lat, S.loc && S.loc.lon, radius, st.lang, st.shown].join('|');
    if (!force && key === st.pharmKey) return;
    st.pharmKey = key;
    const all = st.P.pharmacies;
    let html = `<p class="hint">${esc(T('pharmIntro'))}</p><p class="hint">ⓘ ${esc(T('osmNote'))}</p>`;
    const fs = favs();
    const favList = all.filter((p) => fs.has(pkey(p)));
    if (favList.length) html += `<h4 class="rx-sub">★ ${esc(T('favs'))}</h4><ol class="list rx-favs">${favList.map((p) => card(p, S.loc && p.lat != null ? HS().distKm(S.loc.lat, S.loc.lon, p.lat, p.lon) : null)).join('')}</ol>`;
    let items = [];
    if (!S.loc) {
      html += `<p class="empty" id="rxNeedLoc">${esc(T('needLoc'))}</p>`;
    } else {
      const withC = all.filter((p) => p.lat != null).map((p) => ({ p, d: HS().distKm(S.loc.lat, S.loc.lon, p.lat, p.lon) })).sort((a, b) => a.d - b.d);
      const inR = withC.filter((x) => x.d <= radius);
      items = inR.slice(0, st.shown);
      html += `<h4 class="rx-sub" id="rxNearH">${esc(T('nearby', { r: radius, n: inR.length }))}</h4>`;
      if (!inR.length) html += `<p class="empty">${esc(T('noneInRadius'))}</p>`;
      else html += `<ol class="list" id="rxList">${items.map((x) => card(x.p, x.d)).join('')}</ol>` +
        (inR.length > items.length ? `<p><button type="button" id="rxMore" class="secondary">${esc(T('showMore', { n: Math.min(30, inR.length - items.length) }))}</button></p>` : '');
      // districts around the user: nearest mapped pharmacy's district + districts inside the radius
      const ds = []; if (withC[0]) ds.push(withC[0].p.d);
      inR.forEach((x) => { if (!ds.includes(x.p.d)) ds.push(x.p.d); });
      ds.forEach((d, i) => {
        const nc = all.filter((p) => p.d === d && p.lat == null);
        if (!nc.length) return;
        html += `<details class="rx-group" data-district="${esc(d)}"${i === 0 || st.openD.has('n:' + d) ? ' open' : ''}><summary>${esc(T('noCoordTitle', { d, n: nc.length }))}</summary>
          <p class="hint">${esc(T('noCoordHint'))}</p><ol class="list">${nc.map((p) => card(p, null)).join('')}</ol></details>`;
      });
    }
    const dists = Array.from(new Set(all.map((p) => p.d))).sort();
    html += `<details class="rx-group rx-all" id="rxAll"${st.openD.has('all') ? ' open' : ''}><summary>${esc(T('browseAll', { n: all.length }))}</summary>` +
      dists.map((d) => { const n = all.filter((p) => p.d === d).length; return `<details class="rx-group rx-dist" data-district="${esc(d)}"${st.openD.has('a:' + d) ? ' open' : ''}><summary>${esc(d)} (${n})</summary><ol class="list"></ol></details>`; }).join('') + `</details>`;
    const box = $('#rxPharmBody'); box.innerHTML = html;
    box.querySelectorAll('details.rx-dist').forEach((dt) => {
      const fill = () => { const ol = dt.querySelector('ol'); if (dt.open && !ol.children.length) { ol.innerHTML = all.filter((p) => p.d === dt.dataset.district).map((p) => card(p, null)).join(''); bindFav(ol); } };
      dt.addEventListener('toggle', () => { st.openD[dt.open ? 'add' : 'delete']('a:' + dt.dataset.district); fill(); }); fill();
    });
    const allD = $('#rxAll'); allD.addEventListener('toggle', () => st.openD[allD.open ? 'add' : 'delete']('all'));
    box.querySelectorAll('details.rx-group:not(.rx-all):not(.rx-dist)').forEach((dt) => dt.addEventListener('toggle', () => st.openD[dt.open ? 'add' : 'delete']('n:' + dt.dataset.district)));
    const more = $('#rxMore'); if (more) more.addEventListener('click', () => { st.shown += 30; renderPharm(); });
    bindFav(box);
    st.lastItems = items; drawMap(items);
  }
  function clearRxMap() { const S = HS() && HS().state; if (S && S.markers) S.markers.clearLayers(); }
  function drawMap(items) {
    const H = HS(), map = H.map, S = H.state; if (!map || !S.markers) return;
    S.markers.clearLayers();
    items.forEach((x, i) => {
      L.circleMarker([x.p.lat, x.p.lon], { radius: 7, color: '#fff', weight: 2, fillOpacity: .95, fillColor: '#00897b' })
        .bindPopup(`<b>${esc(x.p.n)}</b><br>${esc(x.p.a)}<br>${H.fmtKm(x.d)}`).addTo(S.markers);
    });
    if (S.loc) {
      if (S.userMarker) S.userMarker.remove();
      S.userMarker = L.marker([S.loc.lat, S.loc.lon], { title: H.t('you') }).bindPopup(H.t('you')).addTo(map);
      const pts = [[S.loc.lat, S.loc.lon]].concat(items.slice(0, 8).map((x) => [x.p.lat, x.p.lon]));
      map.fitBounds(pts, { padding: [24, 24], maxZoom: 14 });
    }
  }

  // ------------------------------------------------------------------ medicine search
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  function buildIndex() {
    const M = st.M, idx = [];
    M.medicines.forEach((m, i) => {
      idx.push({ k: norm(m.n), label: m.n, kind: 'chem', ref: i });
      const seen = new Set();
      m.f.forEach((f) => f.b.forEach(([b]) => { const kb = norm(b); if (kb !== norm(m.n) && !seen.has(kb)) { seen.add(kb); idx.push({ k: kb, label: b, kind: 'brand', ref: i, brand: b }); } }));
    });
    M.immunisation.forEach((m, i) => {
      idx.push({ k: norm(m.n), label: m.n, kind: 'imm', ref: i });
      m.b.forEach((b) => idx.push({ k: norm(b), label: b, kind: 'imm', ref: i, brand: b }));
    });
    M.notListed.forEach((m, i) => idx.push({ k: norm(m.n), label: m.n, kind: 'not', ref: i }));
    Object.keys(window.RX_ALIASES || {}).forEach((en) => {
      const hits = []; M.medicines.forEach((m, i) => { const k = norm(m.n); if (k === en || k.startsWith(en + ' ')) hits.push(i); });
      hits.sort((a, b) => M.medicines[a].n.length - M.medicines[b].n.length);
      RX_ALIASES[en].forEach((al) => hits.slice(0, 3).forEach((i) => idx.push({ k: norm(al), label: M.medicines[i].n, alias: al, kind: 'chem', ref: i })));
    });
    st.idx = idx;
  }
  const KIND_ORDER = { chem: 0, imm: 1, brand: 2, not: 3 };
  function suggest(q) {
    q = norm(q); if (!q || (q.length < 2 && !/[^\x00-\x7f]/.test(q))) return [];
    const out = [];
    st.idx.forEach((e) => {
      let s = -1;
      if (e.k.startsWith(q)) s = 0; else if (e.k.includes(' ' + q) || e.k.includes('-' + q) || e.k.includes('(' + q)) s = 1; else if (e.k.includes(q)) s = 2;
      if (s >= 0) out.push([s, KIND_ORDER[e.kind], e.label.length, e]);
    });
    out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].label.localeCompare(b[3].label));
    const seen = new Set(), res = [];
    for (const o of out) { const e = o[3], id = e.kind + e.ref + (e.brand || ''); if (seen.has(id)) continue; seen.add(id); res.push(e); if (res.length >= 8) break; }
    return res;
  }
  function buildMed() {
    st.medBuilt = true;
    const box = $('#rxMedBody');
    box.innerHTML = `<p class="hint">${esc(T('medIntro'))}</p>
      <div class="rx-search"><label for="rxQ" id="rxQLabel">${esc(T('searchLabel'))}</label>
      <div class="rx-combo"><input id="rxQ" type="search" autocomplete="off" spellcheck="false" placeholder="${esc(T('searchPh'))}"
        role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="rxSugg" aria-describedby="rxSrStatus">
      <ul id="rxSugg" role="listbox" aria-labelledby="rxQLabel" hidden></ul></div>
      <p id="rxSrStatus" class="vh" aria-live="polite"></p></div>
      <div id="rxResult" aria-live="polite"></div>`;
    const q = $('#rxQ');
    q.addEventListener('input', () => { st.sugg = suggest(q.value); st.active = -1; drawSugg(); });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!st.sugg.length) return; e.preventDefault();
        st.active = (st.active + (e.key === 'ArrowDown' ? 1 : -1) + st.sugg.length) % st.sugg.length; drawSugg();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (st.active >= 0) choose(st.sugg[st.active]); else if (st.sugg.length) choose(st.sugg[0]); else if (q.value.trim()) showNotFound(q.value.trim());
      } else if (e.key === 'Escape') { st.sugg = []; drawSugg(); }
    });
    q.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== q) { st.sugg = []; drawSugg(true); } }, 150));
    if (st.result) showResult(st.result);
  }
  function drawSugg(silent) {
    const ul = $('#rxSugg'), q = $('#rxQ'); if (!ul) return;
    ul.innerHTML = st.sugg.map((e, i) => {
      const sub = e.alias ? `${esc(e.alias)} → ` : '';
      const kind = e.kind === 'brand' ? T('brandOf', { c: st.M.medicines[e.ref].n }) : T({ chem: 'kChem', imm: 'kImm', not: 'kNot' }[e.kind]);
      return `<li role="option" id="rxOpt${i}" aria-selected="${i === st.active}" data-i="${i}">${sub}<b>${esc(e.label)}</b> <small>${esc(kind)}</small></li>`;
    }).join('');
    ul.hidden = !st.sugg.length; q.setAttribute('aria-expanded', st.sugg.length ? 'true' : 'false');
    if (st.active >= 0) q.setAttribute('aria-activedescendant', 'rxOpt' + st.active); else q.removeAttribute('aria-activedescendant');
    ul.querySelectorAll('li').forEach((li) => { li.addEventListener('mousedown', (ev) => ev.preventDefault()); li.addEventListener('click', () => choose(st.sugg[+li.dataset.i])); });
    if (!silent) $('#rxSrStatus').textContent = q.value.trim() ? (st.sugg.length ? T('suggCount', { n: st.sugg.length }) : T('noSugg')) : '';
  }
  function choose(e) {
    $('#rxQ').value = e.alias ? e.label : e.label; st.sugg = []; drawSugg(true);
    st.result = e; showResult(e);
  }
  const badge = (s) => `<span class="fund f-${s}">${esc(T('status' + s))}</span>`;
  function linksHTML(ids) {
    const L = st.M.links;
    const items = (ids || []).map((i) => L[i]).filter(Boolean);
    let h = `<div class="rx-whatfor"><h4>${esc(T('whatFor'))}</h4>`;
    if (items.length) h += `<ul>${items.map(([k, title, url]) => `<li><a class="medsafe-link" data-kind="${k}" href="${esc(url)}" target="_blank" rel="noopener">${esc(k === 'cmi' ? T('cmi') : T('ds'))}: ${esc(title)}</a></li>`).join('')}</ul>`;
    else h += `<p>${esc(T('noLink'))} <a class="medsafe-link" data-kind="search" href="${URLS.medsafeSearch}" target="_blank" rel="noopener">${esc(T('medsafeSearch'))}</a></p>`;
    return h + `<p class="hint">${esc(T('linkNote'))}</p></div>`;
  }
  const copayHTML = () => `<div class="rx-copay"><h4>${esc(T('copayTitle'))}</h4><p>${esc(T('copay'))}</p><p class="hint"><a href="${URLS.copay}" target="_blank" rel="noopener">${esc(T('copaySrc'))}</a></p></div>`;
  function showResult(e) {
    const box = $('#rxResult'); let h = '';
    if (e.kind === 'chem' || e.kind === 'brand') {
      const m = st.M.medicines[e.ref];
      h = `<article class="card rxm" data-status="${m.s}" data-kind="chem"><h3 tabindex="-1" id="rxResH">${esc(m.n)}</h3><p>${badge(m.s)}</p><p>${esc(T('expl' + m.s))}</p>` +
        (m.c ? `<p class="rx-cond">⚠️ ${esc(T('cond'))}</p>` : '') +
        `<details class="rx-forms"${m.f.length <= 4 ? ' open' : ''}><summary>${esc(T('formsBrands'))} (${m.f.length})</summary><ul>` +
        m.f.map((f) => `<li><span class="form">${esc(f.n)}</span><br><span class="brands">${esc(T('brandsWord'))}: ` +
          f.b.map(([b, s]) => `<span class="brand${e.brand && e.brand === b ? ' hit' : ''}">${esc(b)} ${badge(s)}</span>`).join(' ') + `</span>${f.c ? ' <small>⚠️</small>' : ''}</li>`).join('') +
        `</ul></details>` + (m.s !== '?' ? copayHTML() : '') + linksHTML(m.l) + `</article>`;
    } else if (e.kind === 'imm') {
      const m = st.M.immunisation[e.ref];
      h = `<article class="card rxm" data-status="I" data-kind="imm"><h3 tabindex="-1" id="rxResH">${esc(m.n)}</h3><p>${badge('I')}</p><p>${esc(T('explI'))}</p>` +
        (m.b.length ? `<p class="brands">${esc(T('brandsWord'))}: ${m.b.map(esc).join(', ')}</p>` : '') + linksHTML(m.l) + `</article>`;
    } else {
      const m = st.M.notListed[e.ref];
      h = `<article class="card rxm" data-status="N" data-kind="not"><h3 tabindex="-1" id="rxResH">${esc(m.n)}</h3><p>${badge('N')}</p><p>${esc(T('explN'))}</p>` + linksHTML(m.l) + `</article>`;
    }
    box.innerHTML = h;
  }
  function showNotFound(q) {
    st.result = null;
    $('#rxResult').innerHTML = `<article class="card rxm" data-status="none"><p>${esc(T('notFound', { q }))}</p>` + linksHTML([]) + `</article>`;
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    $('#tabClinics').addEventListener('click', () => setView('clinics'));
    $('#tabRx').addEventListener('click', (e) => setView('rx', { trigger: e.currentTarget }));
    window.addEventListener('hashchange', () => { if ((location.hash === '#pharmacy' || location.hash === '#medicine') && st.view !== 'rx') setView('rx'); });
    if (location.hash === '#medicine') st.mode = 'med';
    if (location.hash === '#pharmacy' || location.hash === '#medicine') setView('rx', { trigger: $('#tabRx') });
    else document.body.dataset.view = 'clinics';
  }
  window.HaveSickRx = {
    active: () => st.view === 'rx',
    render: () => { if (st.view === 'rx') { if (accepted()) renderPharm(); else clearRxMap(); } },
    onLang: () => { if (!store.get(K_LANG)) { st.lang = defaultLang(); } if (st.view === 'rx') renderShell(); },
    version: DISCLAIMER_VERSION, state: st, setLang, openDialog
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
