/* ==========================================================================
   Alternative Universe · интерактивная политическая карта
   app.js — Vanilla JS, без сборщиков.

   Глобальные зависимости (CDN):  L (Leaflet 1.9.x), topojson (topojson-client/server 3),
   turf (Turf.js 6).
   topojson-simplify подгружается лениво — только при первой оптимизации сетки ADM-1.

   Модули (в порядке объявления):
     1. CONFIG      — константы
     2. Утилиты     — DOM, цвета, URL, base64, хранилища
     3. Store       — appState, история (undo/redo), события, сериализация
     4. Drafts      — автосохранение черновика модератора в localStorage
     5. Geo         — загрузка/парсинг сетки провинций (GeoJSON / TopoJSON)
     6. Геометрия   — Turf-обёртки, Silhouettes (силуэты стран, блоки «сюзерен + вассалы»,
                      площадь в км²), Ruler (линейка по дуге большого круга)
     7. MapView     — Leaflet: подложки, провинции, зоны, столицы, подписи
     8. Tools       — инструменты модератора (кисть, ластик, пипетка, зоны:
                      привязка, лассо, редактор вершин)
     9. GitHub      — GitHub REST API (чтение/запись map-state.json)
    10. UI          — панели, формы, поиск, тосты
    11. App         — инициализация, режим модератора, сохранение
   ========================================================================== */
(() => {
'use strict';

/* ───────────────────────────── 1. CONFIG ───────────────────────────── */
const CONFIG = Object.freeze({
  stateFile: 'map-state.json',
  provincesFile: 'provinces.json',
  // Фоллбэк: все области/провинции мира первого уровня (ADM-1), Natural Earth 10m (~41 МБ)
  adm1: {
    url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson',
    approxBytes: 40_726_851,         // для прогресс-бара, если сервер отдаёт gzip без честного Content-Length
    retain: 0.2,                     // доля точек после упрощения границ (≈280 тыс. точек, ≈5 МБ)
    label: 'Natural Earth 10m ADM-1',
  },
  cache: { db: 'rp_map_cache', store: 'kv', key: 'adm1_provinces', metaKey: 'adm1_provinces_meta', version: 2 },
  topojsonServerUrl: 'https://unpkg.com/topojson-server@3',
  topojsonSimplifyUrl: 'https://unpkg.com/topojson-simplify@3',
  initialView: { center: [48, 18], zoom: 4 },
  labels: {
    fontStack: "'Cinzel', 'Cormorant SC', Georgia, 'Times New Roman', serif",
    letterSpacing: 0.12,            // em — должно совпадать с CSS
    fill: 0.78,                     // доля ширины крупнейшего полигона, которую стремится занять текст
    minPx: 9, maxPx: 18,            // кегль независимых держав
    dependentScale: 0.78,           // зависимые территории — на ~22% мельче
    minTerritoryPx: 38,             // уже — подпись плавно гаснет
    overflow: 1.2,                  // текст даже минимальным кеглем шире территории в 1.2 раза — гаснет
  },
  maxTopologyPoints: 4_000_000,     // выше — не строим топологию (слишком долго для браузера)
  undoLimit: 200,
  currency: '₲',                    // валюта ВВП в карточках (ВВП хранится в млрд)
  snapPx: 12,                       // радиус прилипания к границам, px экрана
  maxEditVertices: 800,             // больше — маркеры вершин не показываются (тормоза DOM)
  silhouetteDebounce: 120,
  tiles: [
    {
      name: 'Физическая карта',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}',
      options: { maxNativeZoom: 8, maxZoom: 18, attribution: 'Tiles &copy; Esri &mdash; Source: US National Park Service' },
    },
    {
      name: 'Затенённый рельеф',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}',
      options: { maxNativeZoom: 13, maxZoom: 18, attribution: 'Tiles &copy; Esri &mdash; Source: Esri' },
    },
  ],
  keys: {
    ui: 'rpmap.ui', gh: 'rpmap.github', token: 'rpmap.github.token',
    draft: 'rpmap.draft', mod: 'rpmap.mod', active: 'rpmap.active',
  },
});

/* ───────────────────────────── 2. УТИЛИТЫ ───────────────────────────── */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Безопасное создание DOM: строки всегда идут через textContent. */
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? node.style.setProperty(sk, sv) : (node.style[sk] = sv);
    } else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
const ic = (cls) => h('i', { class: cls, 'aria-hidden': 'true' });

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const naturalCompare = new Intl.Collator(undefined, { numeric: true }).compare;
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many);
};

/* — цвета — */
function normColor(c) {
  if (typeof c !== 'string') return null;
  let s = c.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((x) => x + x).join('');
  return /^[0-9a-f]{6}$/i.test(s) ? `#${s.toLowerCase()}` : null;
}
function hslToHex(hue, sat, lig) {
  sat /= 100; lig /= 100;
  const k = (n) => (n + hue / 30) % 12, a = sat * Math.min(lig, 1 - lig);
  const f = (n) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
function colorFromString(str) {
  let hash = 0;
  for (const ch of String(str)) hash = (hash * 31 + ch.codePointAt(0)) | 0;
  return hslToHex(Math.abs(hash) % 360, 58, 48);
}
/** amt ∈ [-1..1]: <0 — затемнить, >0 — осветлить. */
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16), t = amt < 0 ? 0 : 255, p = Math.abs(amt);
  const ch = (v) => Math.round((t - v) * p + v);
  return '#' + ((1 << 24) | (ch(n >> 16) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).slice(1);
}

/* — URL — */
/** "[текст](https://x)" → "https://x" (часто прилетает при копипасте из Markdown). */
function stripMarkdownLink(s) {
  const str = String(s ?? '').trim();
  const m = str.match(/^\[[^\]]*\]\(\s*([^)\s]+)\s*\)$/);
  return m ? m[1] : str;
}
function safeHttpUrl(raw, allowRelative = false) {
  const s = stripMarkdownLink(raw);
  if (!s) return '';
  try {
    const u = allowRelative ? new URL(s, location.href) : new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch { return ''; }
}
function cleanTgLink(raw) {
  let s = stripMarkdownLink(raw);
  if (!s) return '';
  if (/^@[A-Za-z0-9_]{3,}$/.test(s)) s = 'https://t.me/' + s.slice(1);
  else if (/^(t\.me|telegram\.me)\//i.test(s)) s = 'https://' + s;
  return safeHttpUrl(s);
}

/* — хранилища (могут быть недоступны в приватном режиме / iframe) — */
function probeStorage(name) {
  try { const s = window[name]; s.setItem('__rp', '1'); s.removeItem('__rp'); return s; } catch { return null; }
}
const LS = probeStorage('localStorage');
const SS = probeStorage('sessionStorage');
const kv = {
  get(area, key, def = null) {
    if (!area) return def;
    try { const v = area.getItem(key); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(area, key, val) {
    if (!area) return false;
    try { area.setItem(key, JSON.stringify(val)); return true; } catch (e) { console.warn('[storage]', e); return false; }
  },
  del(area, key) { try { area && area.removeItem(key); } catch { /* noop */ } },
};

/* — base64 с поддержкой UTF-8 (кириллица в JSON) — */
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
/** SHA git-блоба — чтобы сравнить файл, загруженный с Pages, с версией в репозитории. */
async function gitBlobSha(text) {
  if (!window.crypto?.subtle) return null;
  const enc = new TextEncoder(), body = enc.encode(text), head = enc.encode(`blob ${body.length}\0`);
  const buf = new Uint8Array(head.length + body.length);
  buf.set(head); buf.set(body, head.length);
  const d = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* — сеть / файлы — */
async function fetchJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText || ''} — ${url}`.trim());
  return r.json();
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Не удалось загрузить ${src}`));
    document.head.append(s);
  });
}
function downloadText(text, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function pickFile(input) {
  return new Promise((resolve) => {
    input.value = '';
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

/* — уведомления и загрузчик — */
function toast(msg, type = 'info', ms = 3800) {
  const icons = { info: 'fa-circle-info', ok: 'fa-circle-check', warn: 'fa-triangle-exclamation', error: 'fa-circle-xmark' };
  const t = h('div', { class: `toast toast-${type}`, role: 'status' }, ic(`fa-solid ${icons[type] || icons.info}`), h('span', null, msg));
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}
/**
 * setLoader(false) — скрыть.
 * setLoader(text, { progress, sub }) — progress: 0..1 (полоса), 'indeterminate' или undefined (без полосы).
 */
function setLoader(text, { progress, sub = '' } = {}) {
  const el = $('#loader');
  if (text === false) { el.classList.add('done'); return; }
  el.classList.remove('done');
  $('#loader-text').textContent = text;
  $('#loader-sub').textContent = sub;
  const wrap = $('#loader-progress'), bar = $('#loader-bar');
  wrap.hidden = progress === undefined;
  wrap.classList.toggle('indeterminate', progress === 'indeterminate');
  if (typeof progress === 'number') bar.style.width = `${(clamp(progress, 0, 1) * 100).toFixed(1)}%`;
}
const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(1)} МБ`;

/** fetch + JSON с потоковым прогрессом (ReadableStream). */
async function fetchJsonWithProgress(url, { approxBytes = 0, onProgress } = {}) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} — ${url}`);
  const len = Number(r.headers.get('content-length')) || 0;
  // при gzip Content-Length — размер сжатого тела, а поток отдаёт распакованные байты
  const total = len && (!approxBytes || len >= approxBytes * 0.9) ? len : approxBytes;
  if (!r.body?.getReader) return r.json();
  const reader = r.body.getReader(), chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, Math.max(total, loaded));
  }
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  chunks.length = 0;
  return JSON.parse(new TextDecoder().decode(buf));
}

/* — IndexedDB: кэш оптимизированной сетки (localStorage на 5 МБ для неё мал) — */
const IDB = {
  _db: null,
  open() {
    if (!this._db) {
      this._db = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('IndexedDB недоступен')); return; }
        const req = indexedDB.open(CONFIG.cache.db, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(CONFIG.cache.store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB заблокирован другой вкладкой'));
      }).catch((e) => { this._db = null; throw e; });
    }
    return this._db;
  },
  async _tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CONFIG.cache.store, mode);
      const req = fn(tx.objectStore(CONFIG.cache.store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  },
  get(key) { return this._tx('readonly', (s) => s.get(key)); },
  set(key, val) { return this._tx('readwrite', (s) => s.put(val, key)); },
  del(key) { return this._tx('readwrite', (s) => s.delete(key)); },
};

/* ───────────────────────────── 3. STORE ───────────────────────────── */
const emptyState = () => ({ countries: {}, provinceOwners: {}, provinceNames: {}, customPolygons: [] });

/**
 * Население (в тыс. чел.) и ВВП (в млрд) хранятся числами. Миграция старых сохранений,
 * где там лежали строки: "45 000", "12,5", "₲450 млрд", "1,2 трлн", "45 млн" → число.
 * Единицы в строке пересчитываются: население — тыс./млн/млрд → тыс.; ВВП — млн/млрд/трлн → млрд.
 * Строка-число без единиц для населения > 2 000 000 «тысяч» (больше 2 млрд человек — такого
 * не бывает) — это старый счёт в людях ("45 000 000"), делится на 1000.
 */
function parseNumericStat(v, kind) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  const str = String(v).toLowerCase().replace(/[\s\u00a0\u202f]/g, '');
  const m = str.match(/\d[\d.,]*/);
  if (!m) return null;
  let num = m[0];
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(num)) num = num.replace(/,/g, '');            // 45,000 / 1,234.5
  else if (/^\d{1,3}(\.\d{3}){2,}$/.test(num)) num = num.replace(/\./g, '');           // 45.000.000
  else num = num.replace(',', '.');                                                    // 12,5
  let n = parseFloat(num);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (re) => re.test(str);
  if (kind === 'population') {
    if (unit(/млрд|bn|billion/)) n *= 1e6;
    else if (unit(/млн|mln|million|\bm\b/)) n *= 1e3;
    else if (!unit(/тыс|k\b|thousand/) && n > 2e6) n /= 1e3;                           // > 2 млрд «тысяч» — старый счёт в людях
  } else {
    if (unit(/трлн|trillion|tn/)) n *= 1e3;
    else if (unit(/млн|mln|million/) && !unit(/млрд/)) n /= 1e3;
  }
  return Math.round(n * 1000) / 1000;
}

/**
 * Крупнейшие города: [{ id, name, lat, lng }]. Совместимость со старыми сохранениями:
 * массив строк ["Город 1"] или строка через запятую → объекты с lat/lng = null.
 */
function toCities(v) {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n;]/) : [];
  const used = new Set();
  return arr.map((x, i) => {
    const o = typeof x === 'string' ? { name: x } : x && typeof x === 'object' ? x : null;
    const name = String(o?.name ?? '').trim();
    if (!name) return null;
    const lat = parseFloat(o.lat), lng = parseFloat(o.lng ?? o.lon);
    const ok = Number.isFinite(lat) && Number.isFinite(lng);
    let id = String(o.id ?? '').trim() || `city_${i + 1}`;
    while (used.has(id)) id += '_';
    used.add(id);
    return { id, name, lat: ok ? clamp(lat, -90, 90) : null, lng: ok ? lng : null };
  }).filter(Boolean);
}
const hasPoint = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng);

function normalizeCountry(c) {
  if (!c || typeof c !== 'object') return null;
  const id = String(c.id ?? '').trim();
  if (!id) return null;
  let capital = null;
  if (c.capital && typeof c.capital === 'object') {
    const lat = parseFloat(c.capital.lat), lng = parseFloat(c.capital.lng ?? c.capital.lon);
    const name = String(c.capital.name ?? '').trim();
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
    if (name || hasCoords) capital = { name, lat: hasCoords ? clamp(lat, -90, 90) : null, lng: hasCoords ? lng : null };
  }
  return {
    ...c,
    id,
    name: String(c.name ?? '').trim() || id,
    color: normColor(c.color) || colorFromString(id),
    flagUrl: stripMarkdownLink(c.flagUrl),
    capital,
    population: parseNumericStat(c.population, 'population'),   // тыс. человек, Number | null
    gdp: parseNumericStat(c.gdp, 'gdp'),                        // млрд, Number | null
    cities: toCities(c.cities),
    tgLink: cleanTgLink(c.tgLink),
    description: c.description == null ? '' : String(c.description),
    // зависимость: сюзерен, тип, наследование цвета (по умолчанию — да)
    overlordId: c.overlordId ? String(c.overlordId).trim() || null : null,
    dependencyType: String(c.dependencyType ?? '').trim(),
    inheritOverlordColor: c.inheritOverlordColor !== false,
    hideMapLabel: c.hideMapLabel === true,     // не рисовать постоянную подпись (тултип и карточка работают)
  };
}

const DEPENDENCY_TYPES = ['Зависимая территория', 'Вассал', 'Протекторат', 'Доминион', 'Автономия', 'Марионеточное государство', 'Колония'];
const depLabel = (c) => c.dependencyType || DEPENDENCY_TYPES[0];

/** Убирает ссылки на несуществующих сюзеренов, на самих себя и циклы (A → B → A). */
function sanitizeDependencies(countries) {
  for (const c of Object.values(countries)) {
    if (c.overlordId && (c.overlordId === c.id || !countries[c.overlordId])) c.overlordId = null;
  }
  for (const c of Object.values(countries)) {
    const seen = new Set([c.id]);
    let cur = c;
    while (cur?.overlordId) {
      if (seen.has(cur.overlordId)) { console.warn(`[Store] цикл зависимостей разорван у «${c.name}»`); c.overlordId = null; break; }
      seen.add(cur.overlordId);
      cur = countries[cur.overlordId];
    }
  }
}

/** Значение «Нейтральная территория (ластик зоны)» в списках выбора. В данных хранится как countryId: null. */
const NEUTRAL = '__neutral__';

/**
 * Особая территория хранится как GeoJSON Feature: properties = { name, countryId, neutral }.
 * countryId: null (neutral: true) — нейтральная зона: вырезает кусок из силуэтов всех стран под ней.
 * Порядок в массиве важен: более поздняя зона перекрывает более ранние.
 */
function normalizeCustom(p) {
  if (!p || typeof p !== 'object') return null;
  let geometry = null;
  if (p.type === 'Feature' && p.geometry && /^(Multi)?Polygon$/.test(p.geometry.type)) geometry = p.geometry;
  else if (Array.isArray(p.coordinates) && p.coordinates.length >= 3) {          // упрощённый формат [[lat,lng],…]
    const ring = p.coordinates.map(([lat, lng]) => [Number(lng), Number(lat)]);
    ring.push(ring[0]);
    geometry = { type: 'Polygon', coordinates: [ring] };
  }
  if (!geometry) return null;
  const props = p.properties || {};
  let countryId = props.countryId ?? p.countryId ?? null;
  if (countryId === NEUTRAL || countryId === '') countryId = null;
  return {
    type: 'Feature',
    id: String(p.id ?? props.id ?? uid('poly')),
    properties: { ...props, name: String(props.name ?? p.name ?? ''), countryId, neutral: !countryId },
    geometry,
  };
}

function normalizeState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...src, countries: {}, provinceOwners: {}, provinceNames: {}, customPolygons: [] };
  for (const [fid, name] of Object.entries(src.provinceNames || {})) {          // лорные названия провинций
    const t = String(name ?? '').trim();
    if (t) out.provinceNames[String(fid)] = t;
  }

  const list = Array.isArray(src.countries)
    ? src.countries
    : Object.entries(src.countries || {}).map(([key, v]) => ({ ...v, id: key }));
  for (const c of list) { const n = normalizeCountry(c); if (n) out.countries[n.id] = n; }
  sanitizeDependencies(out.countries);

  let dropped = 0;
  for (const [fid, cid] of Object.entries(src.provinceOwners || {})) {
    if (cid != null && out.countries[cid]) out.provinceOwners[String(fid)] = String(cid);
    else dropped++;
  }
  if (dropped) console.warn(`[Store] пропущено ${dropped} владений с несуществующими государствами`);

  out.customPolygons = (Array.isArray(src.customPolygons) ? src.customPolygons : [])
    .map(normalizeCustom).filter(Boolean)
    .map((p) => {
      if (p.properties.countryId && !out.countries[p.properties.countryId]) Object.assign(p.properties, { countryId: null, neutral: true });
      return p;
    });
  return out;
}

const Store = {
  state: emptyState(),
  sha: null,          // sha файла в репозитории, от которого мы «отталкиваемся»
  dirty: false,
  rev: 0,             // счётчик правок (защита от гонки при сохранении)
  undoStack: [],
  redoStack: [],
  _batch: null,
  _handlers: Object.create(null),

  on(type, fn) { (this._handlers[type] ||= []).push(fn); },
  emit(type, payload) {
    for (const fn of this._handlers[type] || []) {
      try { fn(payload); } catch (e) { console.error(`[Store:${type}]`, e); }
    }
  },

  replace(raw, { sha = null, dirty = false } = {}) {
    this.state = normalizeState(raw);
    this.sha = sha;
    this.undoStack = []; this.redoStack = []; this._batch = null;
    this.setDirty(dirty);
    this.emit('replaced');
    this.emit('history');
  },
  setDirty(v) {
    this.dirty = !!v;
    if (this.dirty) { this.rev++; Drafts.schedule(); }
    this.emit('dirty', this.dirty);
  },

  owner(fid) { return this.state.provinceOwners[fid] || null; },
  country(id) { return (id && this.state.countries[id]) || null; },
  countryList() { return Object.values(this.state.countries).sort((a, b) => a.name.localeCompare(b.name, 'ru')); },
  /* — зависимости — */
  vassals(id) { return this.countryList().filter((c) => c.overlordId === id); },
  allVassals(id, acc = new Set()) {
    for (const v of this.vassals(id)) if (!acc.has(v.id) && v.id !== id) { acc.add(v.id); this.allVassals(v.id, acc); }
    return acc;
  },
  /** Станет ли overlordId предком самого id (цикл)? */
  wouldCycle(id, overlordId) {
    const seen = new Set();
    for (let cur = overlordId; cur; cur = this.state.countries[cur]?.overlordId) {
      if (cur === id || seen.has(cur)) return true;
      seen.add(cur);
    }
    return false;
  },
  /** Корень «блока» — верхний сюзерен по цепочке стран, наследующих его цвет. */
  blocRoot(c) {
    let cur = c, n = 0;
    while (cur?.overlordId && cur.inheritOverlordColor && this.state.countries[cur.overlordId] && n++ < 32) cur = this.state.countries[cur.overlordId];
    return cur?.id;
  },

  provinceCounts() {
    const m = new Map();
    for (const [fid, cid] of Object.entries(this.state.provinceOwners)) {
      if (Geo.byId.size && !Geo.byId.has(fid)) continue;
      m.set(cid, (m.get(cid) || 0) + 1);
    }
    return m;
  },

  /* — владение провинциями + история — */
  beginBatch() { if (!this._batch) this._batch = new Map(); },
  endBatch() {
    const b = this._batch; this._batch = null;
    if (b && b.size) this._pushStep({ owners: b });
  },
  /** Шаг истории: { owners: Map(fid → прежний владелец) } и/или { customs: снимок массива customPolygons }. */
  _pushStep(step) {
    this.undoStack.push(step);
    if (this.undoStack.length > CONFIG.undoLimit) this.undoStack.shift();
    this.redoStack = [];
    this.emit('history');
  },
  _customsSnapshot() { return JSON.parse(JSON.stringify(this.state.customPolygons)); },
  _recordCustoms() { if (this._batch) this.endBatch(); this._pushStep({ customs: this._customsSnapshot() }); },
  _write(fid, cid) { if (cid) this.state.provinceOwners[fid] = cid; else delete this.state.provinceOwners[fid]; },

  setOwner(fid, cid) { return this.setOwners([[fid, cid]]) > 0; },
  setOwners(entries) {
    const auto = !this._batch;
    if (auto) this.beginBatch();
    const touched = [];
    for (const [fid, cid] of entries) {
      const prev = this.owner(fid), next = cid || null;
      if (prev === next) continue;
      if (!this._batch.has(fid)) this._batch.set(fid, prev);
      this._write(fid, next);
      touched.push(fid);
    }
    if (auto) this.endBatch();
    if (touched.length) { this.emit('owners', touched); this.setDirty(true); }
    return touched.length;
  },
  _travel(from, to) {
    const step = from.pop();
    if (!step) return false;
    const back = {};
    if (step.owners) {
      back.owners = new Map();
      for (const [fid, val] of step.owners) {
        back.owners.set(fid, this.owner(fid));
        this._write(fid, val && this.state.countries[val] ? val : null);
      }
    }
    if (step.names) {
      back.names = new Map();
      for (const [fid, val] of step.names) {
        back.names.set(fid, this.state.provinceNames[fid] || null);
        if (val) this.state.provinceNames[fid] = val; else delete this.state.provinceNames[fid];
      }
    }
    if (step.customs) {
      back.customs = this._customsSnapshot();
      this.state.customPolygons = step.customs.map(normalizeCustom).filter(Boolean);
    }
    to.push(back);
    if (step.owners) this.emit('owners', [...step.owners.keys()]);
    if (step.customs) this.emit('custom');
    if (step.names) this.emit('names', [...step.names.keys()]);
    this.emit('history');
    this.setDirty(true);
    return true;
  },
  undo() { if (this._batch) this.endBatch(); return this._travel(this.undoStack, this.redoStack); },
  redo() { return this._travel(this.redoStack, this.undoStack); },

  /* — лорные названия провинций — */
  provinceCustomName(fid) { return this.state.provinceNames[fid] || null; },
  setProvinceName(fid, name) {
    const prev = this.state.provinceNames[fid] || null, next = String(name ?? '').trim() || null;
    if (prev === next) return false;
    if (this._batch) this.endBatch();
    this._pushStep({ names: new Map([[fid, prev]]) });
    if (next) this.state.provinceNames[fid] = next; else delete this.state.provinceNames[fid];
    this.emit('names', [fid]);
    this.setDirty(true);
    return true;
  },

  /* — государства — */
  upsertCountry(data) {
    const c = normalizeCountry(data);
    if (!c) throw new Error('Некорректные данные государства');
    this.state.countries[c.id] = c;
    this.emit('countries');
    this.setDirty(true);
    return c;
  },
  deleteCountry(id) {
    if (!this.state.countries[id]) return;
    delete this.state.countries[id];
    for (const [fid, cid] of Object.entries(this.state.provinceOwners)) if (cid === id) delete this.state.provinceOwners[fid];
    this.state.customPolygons = this.state.customPolygons.filter((p) => p.properties.countryId !== id);
    for (const c of Object.values(this.state.countries)) if (c.overlordId === id) c.overlordId = null;   // вассалы становятся независимыми
    this.undoStack = []; this.redoStack = [];                  // история ссылалась бы на удалённое государство
    this.emit('countries'); this.emit('owners', null); this.emit('custom'); this.emit('history');
    this.setDirty(true);
  },

  /* — пользовательские полигоны — */
  findCustom(id) { return this.state.customPolygons.find((p) => p.id === id) || null; },
  addCustom(f) {
    const n = normalizeCustom(f);
    if (!n) return null;
    this._recordCustoms();
    this.state.customPolygons.push(n);
    this.emit('custom'); this.setDirty(true);
    return n;
  },
  updateCustom(id, patch) {
    const f = this.findCustom(id);
    if (!f) return;
    const next = { ...patch };
    if ('countryId' in next) { next.countryId = next.countryId && next.countryId !== NEUTRAL ? next.countryId : null; next.neutral = !next.countryId; }
    if (!Object.keys(next).some((k) => f.properties[k] !== next[k])) return;
    this._recordCustoms();
    Object.assign(f.properties, next);
    this.emit('custom'); this.setDirty(true);
  },
  setCustomGeometry(id, geometry) {
    const f = this.findCustom(id);
    if (!f || !geometry) return;
    this._recordCustoms();
    f.geometry = geometry;
    this.emit('custom'); this.setDirty(true);
  },
  removeCustom(id) {
    if (!this.findCustom(id)) return;
    this._recordCustoms();
    this.state.customPolygons = this.state.customPolygons.filter((p) => p.id !== id);
    this.emit('custom'); this.setDirty(true);
  },

  /** Стабильная сериализация: ключи provinceOwners отсортированы → аккуратные git-диффы. */
  serialize() {
    const s = this.state, owners = {}, names = {};
    for (const k of Object.keys(s.provinceOwners).sort(naturalCompare)) owners[k] = s.provinceOwners[k];
    for (const k of Object.keys(s.provinceNames).sort(naturalCompare)) names[k] = s.provinceNames[k];
    return JSON.stringify({ ...s, provinceOwners: owners, provinceNames: names }, null, 2) + '\n';
  },
};

/** Цвет страны НА КАРТЕ: вассал с inheritOverlordColor — чуть светлее цвета сюзерена. */
function countryColor(c, depth = 0) {
  if (!c) return '#8a8a8a';
  const o = c.overlordId && c.inheritOverlordColor ? Store.country(c.overlordId) : null;
  return o && depth < 16 ? shade(countryColor(o, depth + 1), 0.12) : c.color;
}
const fmtArea = (km2) => `${Math.round(km2).toLocaleString('ru-RU')} км²`;
const fmtNum = (v, digits) => v.toLocaleString('ru-RU', { maximumFractionDigits: digits });
/** 45000 → «45 000 тыс.», 12.5 → «12,5 тыс.» */
const fmtPop = (k) => `${fmtNum(k, k >= 1000 ? 0 : 2)} тыс.`;
/** 450 → «₲450 млрд», 12.4 → «₲12,4 млрд» */
const fmtGdp = (bn) => `${CONFIG.currency}${fmtNum(bn, bn >= 100 ? 0 : 2)} млрд`;

/**
 * Показатель страны: собственный и вместе со всеми владениями (вассалы вассалов тоже).
 * get(cid) → число или null. → { own, total, depsSum }.
 */
function statWithDeps(cid, get) {
  const own = get(cid) || 0;
  let depsSum = 0;
  for (const v of Store.allVassals(cid)) depsSum += get(v) || 0;
  return { own, total: own + depsSum, depsSum, hasOwn: get(cid) != null && get(cid) !== 0 };
}
const statPop = (cid) => Store.country(cid)?.population ?? null;
const statGdp = (cid) => Store.country(cid)?.gdp ?? null;
const fmtKm = (km) => `${km.toLocaleString('ru-RU', { maximumFractionDigits: km < 10 ? 1 : 0 })} км`;

/* ───────────────────────────── 4. DRAFTS ───────────────────────────── */
const Drafts = {
  schedule: debounce(() => Drafts.save(), 800),
  save() {
    if (!App.modMode || !Store.dirty) return;
    kv.set(LS, CONFIG.keys.draft, { savedAt: Date.now(), baseSha: Store.sha, state: Store.state });
  },
  get() { return kv.get(LS, CONFIG.keys.draft); },
  clear() { kv.del(LS, CONFIG.keys.draft); },
};

/* ───────────────────────────── 5. GEO ───────────────────────────── */
const r3 = (c) => Math.round(c * 1000) / 1000;
const firstFilled = (...vals) => vals.find((v) => v !== undefined && v !== null && String(v).trim() !== '');

function resolveFeatureId(f, i) {
  const v = firstFilled(f.properties?.id, f.id);
  return v === undefined ? `f_${i}` : String(v).trim();
}
/** Название провинции для показа: лорное имя из provinceNames, иначе исходное из сетки. */
function provinceName(f, fallback = true) {
  const fid = f?.properties?.__fid;
  const custom = fid != null ? Store.state.provinceNames?.[fid] : null;
  return custom || provinceOrigName(f, fallback);
}
/** Исходное название из сетки (Natural Earth). */
function provinceOrigName(f, fallback = true) {
  const n = f?.properties?.name;
  if (n) return String(n);
  return fallback ? `Провинция ${f?.properties?.__fid ?? '?'}` : '';
}
const provinceCountry = (f) => (f?.properties?.country ? String(f.properties.country) : '');
/** Реальная страна — только модератору, в скобках (игроку не ломаем погружение в AU). */
const realCountryHint = (f) => (App.modMode && provinceCountry(f) ? `(${provinceCountry(f)})` : '');

function pickTopoObject(topo) {
  const names = Object.keys(topo.objects || {});
  if (!names.length) throw new Error('В TopoJSON нет objects');
  for (const p of ['provinces', 'regions', 'states', 'admin1', 'counties', 'countries']) if (names.includes(p)) return p;
  const size = (n) => topo.objects[n].geometries?.length || 1;
  return names.filter((n) => n !== 'land').sort((a, b) => size(b) - size(a))[0] || names[0];
}
function countCoords(g) {
  if (!g) return 0;
  if (g.type === 'GeometryCollection') return g.geometries.reduce((n, x) => n + countCoords(x), 0);
  let n = 0;
  (function walk(a) { if (typeof a[0] === 'number') { n++; return; } for (const x of a) walk(x); })(g.coordinates || []);
  return n;
}

/* — очистка геометрии — */
const isAntarctica = (p, f) =>
  p.admin === 'Antarctica' || p.ADMIN === 'Antarctica' || p.adm0_a3 === 'ATA' || p.ADM0_A3 === 'ATA' ||
  p.country === 'Antarctica' || p.name === 'Antarctica' || String(f.id) === '010';

/**
 * Разворачивает кольцо через 180° меридиан: если соседние точки отличаются по долготе
 * больше чем на 180°, текущая долгота сдвигается на ±360°. Заодно — округление до 3 знаков,
 * удаление повторов подряд и замыкание кольца. Возвращает null для вырожденного кольца.
 */
function unwrapRing(ring) {
  const out = [];
  let prev = null;
  for (const pt of ring) {
    let lon = +pt[0];
    const lat = +pt[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (prev !== null) {
      while (lon - prev > 180) lon -= 360;
      while (prev - lon > 180) lon += 360;
    }
    prev = lon;
    const x = r3(lon), y = r3(lat), last = out[out.length - 1];
    if (!last || last[0] !== x || last[1] !== y) out.push([x, y]);
  }
  if (out.length < 3) return null;
  const a = out[0], z = out[out.length - 1];
  if (Math.abs(z[0] - a[0]) > 180) return null;           // кольцо вокруг полюса — заливка через весь мир
  if (a[0] !== z[0] || a[1] !== z[1]) out.push([a[0], a[1]]);
  return out.length >= 4 ? out : null;
}
const ringMeanLon = (r) => { let s = 0; for (let i = 0; i < r.length - 1; i++) s += r[i][0]; return s / (r.length - 1); };
const shiftRing = (r, d) => { if (d) for (const p of r) p[0] = r3(p[0] + d); };

/** Чистит геометрию одного объекта. → { type, coordinates } или null. */
function sanitizeGeometry(g) {
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return null;
  const src = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const polys = [];
  for (const poly of src || []) {
    if (!Array.isArray(poly) || !poly.length) continue;
    const outer = unwrapRing(poly[0]);
    if (!outer) continue;
    polys.push([outer, ...poly.slice(1).map(unwrapRing).filter(Boolean)]);
  }
  if (!polys.length) return null;

  // Natural Earth режет объекты по 180°: части Чукотки/Фиджи лежат по разные стороны карты.
  // Собираем их в одну «копию мира» рядом с самым крупным кольцом, чтобы область рисовалась целиком.
  const rings = polys.flat();
  const anchorRing = polys.map((p) => p[0]).reduce((a, b) => (b.length > a.length ? b : a));
  let anchor = ringMeanLon(anchorRing);
  const base = anchor > 180 ? -360 : anchor < -180 ? 360 : 0;
  anchor += base;
  for (const r of rings) shiftRing(r, r === anchorRing ? base : Math.round((anchor - ringMeanLon(r)) / 360) * 360);
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

/** Облегчает один объект: только id / name / country. → Feature или null. */
function sanitizeFeature(f, i) {
  if (!f || f.type !== 'Feature') return null;
  const p = f.properties || {};
  if (isAntarctica(p, f)) return null;
  const geometry = sanitizeGeometry(f.geometry);
  if (!geometry) return null;
  const id = firstFilled(p.adm1_code, p.id, p.diss_me, p.ne_id, f.id, p.ID, p.GID_2, p.GID_1, p.GID_0, p.iso_3166_2);
  const name = firstFilled(p.name, p.name_ru, p.name_en, p.NAME, p.NAME_2, p.NAME_1, p.NAME_0);
  const country = firstFilled(p.admin, p.geonunit, p.country, p.ADMIN, p.COUNTRY);
  return {
    type: 'Feature',
    properties: {
      id: id === undefined ? `f_${i}` : String(id).trim(),
      name: name === undefined ? '' : String(name),
      country: country === undefined ? '' : String(country),
    },
    geometry,
  };
}

/**
 * Через эту функцию проходит любая загружаемая сетка:
 *  1) удаляет Антарктиду; 2) лечит разрывы на 180° меридиане;
 *  3) округляет координаты до 3 знаков и оставляет в properties только id, name, country.
 * Принимает FeatureCollection / Feature / массив Feature. Возвращает FeatureCollection.
 * С флагом keepIndex — массив той же длины с null на месте выброшенных объектов
 * (нужно, чтобы не потерять соответствие с геометриями TopoJSON).
 */
function sanitizeGeoJSON(geojson, { keepIndex = false } = {}) {
  const list = geojson?.type === 'FeatureCollection' ? geojson.features
    : geojson?.type === 'Feature' ? [geojson]
    : Array.isArray(geojson) ? geojson : null;
  if (!list) throw new Error('Неизвестный формат: нужен GeoJSON (FeatureCollection) или TopoJSON (Topology)');
  const features = list.map((f, i) => sanitizeFeature(f, i));
  return keepIndex ? features : { type: 'FeatureCollection', features: features.filter(Boolean) };
}

/**
 * Natural Earth режет области по 180° меридиану. После «сшивки» в sanitizeGeometry части
 * одной области стыкуются по линии ±180°, но остаются отдельными полигонами — в контуре
 * страны и сетке появлялся бы шов. Склеиваем такие части через turf.union.
 */
/** Удвоенная знаковая площадь кольца: > 0 — против часовой стрелки (в координатах lon/lat). */
function ringSignedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a;
}

function healAntimeridian(features) {
  if (!hasTurf()) return 0;
  const onSeam = (a, b) => Math.abs(Math.abs(a[0]) - 180) < 1e-9 && Math.abs(Math.abs(b[0]) - 180) < 1e-9;
  const touches = (poly) => poly.some((ring) => ring.some((pt, i) => i > 0 && onSeam(ring[i - 1], pt)));
  let healed = 0;
  for (const f of features) {
    const g = f.geometry;
    if (g?.type !== 'MultiPolygon') continue;
    const seam = g.coordinates.filter(touches);
    if (seam.length < 2) continue;
    const rest = g.coordinates.filter((p) => !seam.includes(p));
    const merged = unionMany(seam.map((c) => ({ type: 'Polygon', coordinates: c })));
    if (!merged) continue;
    const parts = merged.type === 'Polygon' ? [merged.coordinates] : merged.coordinates;
    if (parts.length >= seam.length) continue;                     // склеить не удалось — оставляем как было
    // turf отдаёт внешние кольца против часовой стрелки, а сетка (Natural Earth / d3) — по часовой.
    // Для topojson.merge направление обхода должно совпадать у соседей, иначе силуэт не сошьётся.
    const extCW = ringSignedArea(seam[0][0]) < 0;
    const orient = (ring, cw) => ((ringSignedArea(ring) < 0) === cw ? ring : ring.slice().reverse());
    const all = rest.concat(parts.map((poly) => poly.map((ring, k) =>
      orient(ring.map(([x, y]) => [r3(x), r3(y)]), k === 0 ? extCW : !extCW))));
    f.geometry = all.length === 1 ? { type: 'Polygon', coordinates: all[0] } : { type: 'MultiPolygon', coordinates: all };
    healed++;
  }
  return healed;
}

/* — подключение topojson-server / topojson-simplify по требованию (все UMD пишут в window.topojson) — */
async function ensureTopojson(fn, url) {
  if (window.topojson?.[fn]) return true;
  const before = window.topojson;
  await loadScript(url);
  if (before && window.topojson !== before) window.topojson = Object.assign({}, before, window.topojson);
  return !!window.topojson?.[fn];
}

/**
 * Упрощение границ с сохранением топологии: общие границы соседних областей
 * упрощаются одинаково, поэтому щелей и наложений не появляется.
 * Области, которые схлопнулись бы целиком, сохраняют исходную геометрию.
 */
async function optimizeGeoJSON(fc, retain) {
  if (!(await ensureTopojson('topology', CONFIG.topojsonServerUrl))) return fc;
  if (!(await ensureTopojson('presimplify', CONFIG.topojsonSimplifyUrl))) return fc;
  const T = window.topojson;
  const topo = T.presimplify(T.topology({ p: fc }));
  const simple = T.simplify(topo, T.quantile(topo, retain));
  const out = sanitizeGeoJSON(T.feature(simple, simple.objects.p), { keepIndex: true });
  return {
    type: 'FeatureCollection',
    features: fc.features.map((orig, i) => (out[i] ? { ...out[i], properties: orig.properties } : orig)),
  };
}

/** Топология нужна для быстрого и точного слияния провинций в силуэты стран (topojson.merge). */
async function buildTopology(features) {
  const pts = features.reduce((n, f) => n + countCoords(f.geometry), 0);
  if (pts > CONFIG.maxTopologyPoints) {
    console.warn(`[Geo] ${pts} точек — топология не строится; уменьшите сетку (mapshaper -simplify)`);
    return null;
  }
  try {
    if (!(await ensureTopojson('topology', CONFIG.topojsonServerUrl))) return null;
    return window.topojson.topology({ provinces: { type: 'FeatureCollection', features } });
  } catch (e) {
    console.warn('[Geo] не удалось построить топологию', e);
    return null;
  }
}

const Geo = {
  features: [],
  byId: new Map(),
  topology: null,
  object: null,
  geomOfFid: new Map(),   // featureId → geometry-объект топологии (для topojson.merge)
  source: '—',

  /** Порядок: локальный provinces.json → кэш IndexedDB → скачивание ADM-1 Natural Earth. */
  async loadDefault() {
    let local = null;
    try { local = await fetchJson(CONFIG.provincesFile); } catch (e) {
      console.info(`[Geo] ${CONFIG.provincesFile} недоступен (${e.message})`);
    }
    if (local) {
      setLoader(`Обработка ${CONFIG.provincesFile}…`, { progress: 'indeterminate' });
      await nextFrame();
      return this.ingest(local, CONFIG.provincesFile);
    }

    const cached = await this.readCache();
    if (cached) {
      setLoader('Сетка ADM-1 из кэша браузера…', { progress: 'indeterminate' });
      await nextFrame();
      return this.ingest(cached, `${CONFIG.adm1.label} · кэш браузера`, { sanitized: true });
    }
    return this.downloadAdm1();
  },

  async downloadAdm1() {
    const title = 'Загрузка и оптимизация мировой сетки провинций ADM-1...';
    setLoader(title, { progress: 0, sub: 'Шаг 1/4 · скачивание Natural Earth 10m' });
    let lastPaint = 0;
    const raw = await fetchJsonWithProgress(CONFIG.adm1.url, {
      approxBytes: CONFIG.adm1.approxBytes,
      onProgress: (loaded, total) => {
        const now = performance.now();
        if (now - lastPaint < 60 && loaded < total) return;
        lastPaint = now;
        setLoader(title, { progress: loaded / total * 0.8, sub: `Шаг 1/4 · скачивание: ${fmtMB(loaded)} из ~${fmtMB(total)}` });
      },
    });

    setLoader(title, { progress: 0.82, sub: 'Шаг 2/4 · очистка: Антарктида, 180° меридиан, лишние поля' });
    await nextFrame();
    let fc = sanitizeGeoJSON(raw);

    setLoader(title, { progress: 0.88, sub: `Шаг 3/4 · упрощение границ (${fc.features.length} областей)` });
    await nextFrame();
    try { fc = await optimizeGeoJSON(fc, CONFIG.adm1.retain); } catch (e) { console.warn('[Geo] упрощение не удалось', e); }

    setLoader(title, { progress: 0.96, sub: 'Шаг 4/4 · сохранение в кэш браузера' });
    await nextFrame();
    await this.writeCache(fc);
    return this.ingest(fc, CONFIG.adm1.label, { sanitized: true });
  },

  async readCache() {
    try {
      const rec = await IDB.get(CONFIG.cache.key);
      if (rec?.version === CONFIG.cache.version && rec.data?.features?.length) return rec.data;
    } catch (e) { console.info('[Geo] кэш недоступен', e.message); }
    return null;
  },
  async writeCache(fc) {
    try {
      await IDB.set(CONFIG.cache.key, { version: CONFIG.cache.version, data: fc });
      await IDB.set(CONFIG.cache.metaKey, { version: CONFIG.cache.version, savedAt: Date.now(), count: fc.features.length });
    } catch (e) { console.warn('[Geo] не удалось записать кэш', e); }
  },
  async cacheInfo() {
    try { const m = await IDB.get(CONFIG.cache.metaKey); return m?.version === CONFIG.cache.version ? m : null; } catch { return null; }
  },
  async clearCache() { await IDB.del(CONFIG.cache.key); await IDB.del(CONFIG.cache.metaKey); },

  /** Лёгкий GeoJSON текущей сетки — для provinces.json в корне репозитория. */
  exportGeoJSON() {
    return JSON.stringify({
      type: 'FeatureCollection',
      features: this.features.map((f) => ({
        type: 'Feature',
        properties: { id: f.properties.id, name: f.properties.name, country: f.properties.country },
        geometry: f.geometry,
      })),
    });
  },

  async ingest(data, label, { sanitized = false } = {}) {
    let fc;
    if (data && data.type === 'Topology') {
      if (!window.topojson?.feature) throw new Error('topojson-client не загружен');
      const obj = data.objects[pickTopoObject(data)];
      fc = window.topojson.feature(data, obj);
      if (fc.type !== 'FeatureCollection') fc = { type: 'FeatureCollection', features: [fc] };
    } else {
      fc = data;
    }
    // Любая сетка проходит через sanitizeGeoJSON; уже очищенная (кэш) — повторно не обрабатывается.
    // Топология всегда строится заново из очищенных объектов — иначе линии границ
    // взялись бы из «сырых» дуг и снова тянулись бы через весь мир.
    const features = sanitized ? fc.features : sanitizeGeoJSON(fc).features;
    if (!features.length) throw new Error('В сетке нет полигонов');
    const healed = healAntimeridian(features);
    if (healed) console.info(`[Geo] склеено по 180° меридиану: ${healed} областей`);

    const seen = new Set(), byId = new Map();
    features.forEach((f, i) => {
      let fid = resolveFeatureId(f, i);
      if (seen.has(fid)) fid = `${fid}__${i}`;
      seen.add(fid);
      f.properties.__fid = fid;
      byId.set(fid, f);
    });

    setLoader('Строим топологию границ…', { progress: 'indeterminate', sub: `${features.length} областей` });
    await nextFrame();
    const topology = await buildTopology(features);
    const object = topology ? topology.objects.provinces : null;
    const geomOfFid = new Map();
    if (object) object.geometries.forEach((g, i) => features[i] && geomOfFid.set(features[i].properties.__fid, g));

    Object.assign(this, { features, byId, topology, object, geomOfFid, source: label });
    return this;
  },
};

/* ───────────────────────────── 6. ГЕОМЕТРИЯ И СИЛУЭТЫ ───────────────────────────── */
const hasTurf = () => !!window.turf;

function walkCoords(g, fn) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const poly of polys) for (const ring of poly) for (const pt of ring) fn(pt);
}
const bboxCache = new WeakMap();
function geomBBox(g) {
  let b = bboxCache.get(g);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    walkCoords(g, ([x, y]) => { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; });
    bboxCache.set(g, b);
  }
  return b;
}
const bboxHit = (p, q) => !!(p && q && p[0] <= q[2] && p[2] >= q[0] && p[1] <= q[3] && p[3] >= q[1]);
const bboxMerge = (p, q) => (!p ? q : !q ? p : [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[2], q[2]), Math.max(p[3], q[3])]);

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
const geomKeyCache = new WeakMap();
function geomKey(g) {
  let k = geomKeyCache.get(g);
  if (!k) { k = hashStr(JSON.stringify(g.coordinates)); geomKeyCache.set(g, k); }
  return k;
}

/** Булева операция Turf с повторной попыткой на очищенной геометрии. Ошибка → геометрия «a» без изменений. */
function turfOp(op, a, b) {
  const T = window.turf;
  const run = (x, y) => { const r = T[op](T.feature(x), T.feature(y)); return r ? r.geometry : null; };
  try { return run(a, b); } catch { /* повтор ниже */ }
  try {
    const clean = (g) => {
      const f = T.cleanCoords(T.feature(g));
      return T.kinks(f).features.length ? unionMany(T.unkinkPolygon(f).features.map((x) => x.geometry)) : f.geometry;
    };
    return run(clean(a), clean(b));
  } catch (e) {
    console.warn(`[turf.${op}] не удалось`, e);
    return a;
  }
}
const tUnion = (a, b) => (!a ? b : !b ? a : hasTurf() ? turfOp('union', a, b) : a);
const tDiff  = (a, b) => (!a ? null : !b || !hasTurf() ? a : turfOp('difference', a, b));
/** Объединение многих геометрий «деревом» (быстрее последовательного). */
function unionMany(geoms) {
  let list = geoms.filter(Boolean);
  while (list.length > 1) {
    const next = [];
    for (let i = 0; i < list.length; i += 2) next.push(i + 1 < list.length ? tUnion(list[i], list[i + 1]) : list[i]);
    list = next;
  }
  return list[0] || null;
}

/**
 * Кольца из L.LatLng → GeoJSON-геометрия. Самопересечения разбираются (turf.unkinkPolygon),
 * лишние точки чистятся (turf.cleanCoords). polys: [[ring(LatLng[]), hole, …], …]
 */
function latlngsToGeometry(polys) {
  const P = polys
    .map((rings) => rings.filter((pts) => pts && pts.length >= 3).map((pts) => {
      const r = pts.map((p) => [round6(p.lng), round6(p.lat)]);
      r.push([...r[0]]);
      return r;
    }))
    .filter((rings) => rings.length);
  if (!P.length) return null;
  let g = P.length === 1 ? { type: 'Polygon', coordinates: P[0] } : { type: 'MultiPolygon', coordinates: P };
  if (!hasTurf()) return g;
  try {
    const f = turf.cleanCoords(turf.feature(g));
    g = turf.kinks(f).features.length ? unionMany(turf.unkinkPolygon(f).features.map((x) => x.geometry)) : f.geometry;
  } catch (e) { console.warn('[geometry] очистка не удалась', e); }
  return g;
}

/* — точка и рамка подписи — */
const D2R = Math.PI / 180;
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + clamp(lat, -85, 85) * D2R / 2)) / D2R;
const mercLat = (y) => (2 * Math.atan(Math.exp(y * D2R)) - Math.PI / 2) / D2R;

/** Знаковое расстояние от точки до полигона (> 0 — внутри). poly: [outer, ...holes] в плоских координатах. */
function pointToPolygonDist(x, y, poly) {
  let inside = false, minSq = Infinity;
  for (const ring of poly) {
    for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      let px = a[0], py = a[1], dx = b[0] - px, dy = b[1] - py;
      if (dx || dy) {
        const t = clamp(((x - px) * dx + (y - py) * dy) / (dx * dx + dy * dy), 0, 1);
        px += dx * t; py += dy * t;
      }
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < minSq) minSq = d;
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(minSq);
}

/**
 * Полюс недоступности (алгоритм polylabel, Mapbox): точка внутри полигона, максимально удалённая
 * от его границ, — лучшее место для подписи (центроид у вогнутых фигур может оказаться снаружи или в море).
 */
function polylabel(poly, precision, maxCells = 900) {
  const outer = poly[0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of outer) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  const width = maxX - minX, height = maxY - minY, cellSize = Math.min(width, height);
  if (!cellSize) return [minX, minY];
  const cell = (x, y, hh) => { const d = pointToPolygonDist(x, y, poly); return { x, y, h: hh, d, max: d + hh * Math.SQRT2 }; };
  // простая куча по убыванию max
  const heap = [];
  const push = (c) => { heap.push(c); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].max >= c.max) break; heap[i] = heap[p]; i = p; } heap[i] = c; };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mv = last.max;
        if (l < heap.length && heap[l].max > mv) { m = l; mv = heap[l].max; }
        if (r < heap.length && heap[r].max > mv) m = r;
        if (m === i) break;
        heap[i] = heap[m]; i = m;
      }
      heap[i] = last;
    }
    return top;
  };
  let hh = cellSize / 2;
  for (let x = minX; x < maxX; x += cellSize) for (let y = minY; y < maxY; y += cellSize) push(cell(x + hh, y + hh, hh));
  // стартовые кандидаты: центр рамки и центроид
  let best = cell(minX + width / 2, minY + height / 2, 0);
  let A = 0, cx = 0, cy = 0;
  for (let i = 0, len = outer.length, j = len - 1; i < len; j = i++) {
    const a = outer[i], b = outer[j], f = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * f; cy += (a[1] + b[1]) * f; A += f * 3;
  }
  if (A) { const c = cell(cx / A, cy / A, 0); if (c.d > best.d) best = c; }
  let n = heap.length;
  while (heap.length && n < maxCells) {
    const c = pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    hh = c.h / 2;
    push(cell(c.x - hh, c.y - hh, hh)); push(cell(c.x + hh, c.y - hh, hh));
    push(cell(c.x - hh, c.y + hh, hh)); push(cell(c.x + hh, c.y + hh, hh));
    n += 4;
  }
  return [best.x, best.y];
}

/**
 * Якорь подписи страны: самый большой по площади полигон силуэта (материк, а не острова/колонии),
 * в нём — полюс недоступности. → { ll: [lat, lng], bbox: [w, s, e, n] крупнейшего полигона }.
 */
const labelAnchorCache = new WeakMap();
function labelAnchor(g) {
  let res = labelAnchorCache.get(g);
  if (res) return res;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let best = null, bestArea = -1;
  for (const poly of polys) {
    let area;
    if (hasTurf()) { try { area = turf.area({ type: 'Polygon', coordinates: poly }); } catch { area = 0; } }
    else {
      const r = poly[0]; area = 0;
      for (let i = 0; i < r.length - 1; i++) area += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
      area = Math.abs(area) * Math.cos((r[0][1] || 0) * D2R);
    }
    if (area > bestArea) { bestArea = area; best = poly; }
  }
  if (!best) return null;
  // считаем в проекции Меркатора — как на экране
  const planar = best.map((ring) => ring.map(([x, y]) => [x, mercY(y)]));
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of best[0]) { if (x < w) w = x; if (y < s) s = y; if (x > e) e = x; if (y > n) n = y; }
  const size = Math.max(e - w, mercY(n) - mercY(s));
  const [px, py] = polylabel(planar, size / 120);
  res = { ll: [mercLat(py), px], bbox: [w, s, e, n] };
  labelAnchorCache.set(g, res);
  return res;
}

/** Ширина текста подписи при кегле 1px (с учётом верхнего регистра и letter-spacing). */
const labelWidthCache = new Map();
let labelCtx = null;
function labelUnitWidth(text) {
  let w = labelWidthCache.get(text);
  if (w === undefined) {
    labelCtx ||= document.createElement('canvas').getContext('2d');
    labelCtx.font = `600 100px ${CONFIG.labels.fontStack}`;
    const up = text.toLocaleUpperCase('ru');
    w = (labelCtx.measureText(up).width + [...up].length * CONFIG.labels.letterSpacing * 100) / 100;
    labelWidthCache.set(text, w);
  }
  return w;
}

/**
 * Единые силуэты государств: провинции страны (topojson.merge по общим дугам — без щелей)
 * ∪ её особые территории − чужие/нейтральные зоны поверх (turf.union / turf.difference).
 * Зоны применяются в порядке массива customPolygons: поздняя перекрывает раннюю.
 * Кэш по стране: пересчитываются только страны, у которых изменились провинции
 * или затрагивающие их зоны.
 */
const Silhouettes = {
  cache: new Map(),     // cid → { provSig, provGeom, provBBox, key, geom, area, rev }
  layers: new Map(),    // cid → L.Polygon (заливка; контур — в зависимости от роли в блоке)
  blocs: new Map(),     // rootId → { key, geom, layer } — внешний контур сюзерена вместе с вассалами
  blocMembers: new Map(),
  group: null, renderer: null,
  blocGroup: null, blocRenderer: null,

  init(map) {
    this.renderer = L.canvas({ pane: 'silhouettePane', padding: 0.5 });
    this.blocRenderer = L.canvas({ pane: 'blocPane', padding: 0.5 });
    this.group = L.layerGroup().addTo(map);
    this.blocGroup = L.layerGroup().addTo(map);
  },
  schedule: debounce(() => Silhouettes.rebuild(), CONFIG.silhouetteDebounce),
  reset() {
    this.cache.clear(); this.layers.clear(); this.blocs.clear();
    this.group.clearLayers(); this.blocGroup.clearLayers();
  },

  geom(cid) { return this.cache.get(cid)?.geom || null; },
  /** Площадь собственной территории, км² (turf.area по силуэту: провинции + свои зоны − чужие). */
  area(cid) { return this.cache.get(cid)?.area || 0; },
  /** Площадь вместе со всеми зависимыми территориями (рекурсивно). */
  totalArea(cid) { let sum = this.area(cid); for (const v of Store.allVassals(cid)) sum += this.area(v); return sum; },

  /** 'solo' — сама по себе; 'root' — сюзерен блока; 'member' — вассал, наследующий цвет. */
  role(cid) {
    const root = Store.blocRoot(Store.country(cid));
    if (root !== cid) return 'member';
    return (this.blocMembers.get(cid)?.length || 0) > 1 ? 'root' : 'solo';
  },
  style(cid) {
    const c = Store.country(cid), col = countryColor(c), role = this.role(cid);
    const st = { interactive: false, lineJoin: 'round', fill: true, fillColor: col, fillOpacity: MapView.selected === cid ? 0.72 : 0.55 };
    if (role === 'solo') return { ...st, stroke: true, color: shade(col, -0.45), weight: 2.2, opacity: 0.95, dashArray: null };
    if (role === 'root') return { ...st, stroke: false, dashArray: null };                     // контур рисует блок
    return { ...st, stroke: true, color: shade(col, -0.55), weight: 1.3, opacity: 0.9, dashArray: '6 5' };   // граница вассала
  },
  blocStyle(root) {
    const col = countryColor(Store.country(root));
    return { interactive: false, stroke: true, fill: false, color: shade(col, -0.45), weight: 2.2, opacity: 0.95, lineJoin: 'round' };
  },
  restyle(ids) {
    for (const [cid, layer] of this.layers) {
      if (ids && !ids.includes(cid)) continue;
      if (Store.country(cid)) layer.setStyle(this.style(cid));
    }
    if (!ids) for (const [root, b] of this.blocs) if (b.layer && Store.country(root)) b.layer.setStyle(this.blocStyle(root));
  },

  mergeProvinces(fids) {
    if (!fids.length) return null;
    if (Geo.topology && window.topojson?.merge) {
      try {
        const g = window.topojson.merge(Geo.topology, fids.map((fid) => Geo.geomOfFid.get(fid)).filter(Boolean));
        return g.coordinates.length ? g : null;
      } catch (e) { console.warn('[Silhouettes] topojson.merge', e); }
    }
    return unionMany(fids.map((fid) => Geo.byId.get(fid)?.geometry));
  },

  rebuild() {
    const t0 = performance.now();
    const byCountry = new Map();
    for (const [fid, cid] of Object.entries(Store.state.provinceOwners)) {
      if (!Geo.byId.has(fid)) continue;
      let arr = byCountry.get(cid);
      if (!arr) byCountry.set(cid, (arr = []));
      arr.push(fid);
    }
    const zones = Store.state.customPolygons.map((p) => ({
      owner: p.properties.countryId || null,
      geom: p.geometry,
      bbox: geomBBox(p.geometry),
      key: `${p.id}:${p.properties.countryId || '∅'}:${geomKey(p.geometry)}`,
    }));

    const changed = [];
    for (const c of Object.values(Store.state.countries)) {
      const fids = (byCountry.get(c.id) || []).sort();
      const provSig = fids.join('\u0001');
      let e = this.cache.get(c.id);
      if (!e) this.cache.set(c.id, (e = { rev: 0 }));
      let dirty = false;
      if (e.provSig !== provSig) {
        e.provSig = provSig;
        e.provGeom = this.mergeProvinces(fids);
        e.provBBox = e.provGeom ? geomBBox(e.provGeom) : null;
        dirty = true;
      }
      let area = e.provBBox;
      for (const z of zones) if (z.owner === c.id) area = bboxMerge(area, z.bbox);
      const relevant = zones.filter((z) => z.owner === c.id || bboxHit(z.bbox, area));
      const key = relevant.map((z) => z.key).join('|');
      if (dirty || e.key !== key) {
        e.key = key;
        let g = e.provGeom;
        for (const z of relevant) g = z.owner === c.id ? tUnion(g, z.geom) : tDiff(g, z.geom);
        e.geom = g;
        e.area = geoAreaKm2(g);
        e.rev++;
        changed.push(c.id);
      }
    }
    for (const cid of [...this.cache.keys()]) if (!Store.state.countries[cid]) { this.cache.delete(cid); changed.push(cid); }

    this.refreshVisuals(changed);
    if (changed.length) {
      MapView.renderLabels();
      UI.scheduleRefresh();                    // площади в списке и карточке
      console.debug(`[Silhouettes] пересчитано стран: ${changed.length} за ${Math.round(performance.now() - t0)} мс`);
    }
  },

  /** Перерисовать изменённые страны, пересобрать блоки «сюзерен + вассалы», обновить стили всех. */
  refreshVisuals(changed = []) {
    for (const cid of changed) this.draw(cid);
    const members = new Map();
    for (const c of Object.values(Store.state.countries)) {
      const r = Store.blocRoot(c);
      if (!members.has(r)) members.set(r, []);
      members.get(r).push(c.id);
    }
    this.blocMembers = members;
    this.renderBlocs();
    this.restyle();
  },
  renderBlocs() {
    const live = new Set();
    for (const [root, ids] of this.blocMembers) {
      if (ids.length < 2) continue;
      const withGeom = ids.filter((cid) => this.geom(cid)).sort();
      if (!withGeom.length) continue;
      live.add(root);
      const key = withGeom.map((cid) => `${cid}:${this.cache.get(cid).rev}`).join('|');
      const old = this.blocs.get(root);
      if (old && old.key === key) continue;
      if (old?.layer) this.blocGroup.removeLayer(old.layer);
      const g = unionMany(withGeom.map((cid) => this.geom(cid)));
      const layer = g ? L.GeoJSON.geometryToLayer({ type: 'Feature', geometry: g }, { renderer: this.blocRenderer, pane: 'blocPane', ...this.blocStyle(root) }) : null;
      if (layer) this.blocGroup.addLayer(layer);
      this.blocs.set(root, { key, geom: g, layer });
    }
    for (const [root, b] of this.blocs) {
      if (live.has(root)) continue;
      if (b.layer) this.blocGroup.removeLayer(b.layer);
      this.blocs.delete(root);
    }
  },

  draw(cid) {
    const old = this.layers.get(cid);
    if (old) { this.group.removeLayer(old); this.layers.delete(cid); }
    const g = this.geom(cid);
    if (!g || !Store.country(cid)) return;
    const layer = L.GeoJSON.geometryToLayer({ type: 'Feature', geometry: g }, { renderer: this.renderer, pane: 'silhouettePane', ...this.style(cid) });
    this.layers.set(cid, layer);
    this.group.addLayer(layer);
  },
};

/** Реальная площадь геометрии в км² (сферическая, turf.area). */
function geoAreaKm2(g) {
  if (!g || !hasTurf()) return 0;
  try { return Math.round(turf.area(g) / 1e6); } catch { return 0; }
}

/* ───────────────────────────── ЛИНЕЙКА ───────────────────────────── */
/** Точки дуги большого круга между a и b — линия на карте совпадает с измеренным расстоянием. */
function greatCirclePath(a, b) {
  const R = Math.PI / 180, la1 = a.lat * R, lo1 = a.lng * R, la2 = b.lat * R, lo2 = b.lng * R;
  const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
  const n = Math.min(96, Math.ceil(a.distanceTo(b) / 50_000));          // точка каждые ~50 км
  if (d < 1e-9 || n < 2) return [a, b];
  const out = [];
  let prev = a.lng;
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    let lng = Math.atan2(y, x) / R;
    while (lng - prev > 180) lng -= 360;
    while (prev - lng > 180) lng += 360;
    prev = lng;
    out.push(L.latLng(Math.atan2(z, Math.hypot(x, y)) / R, lng));
  }
  return out;
}

const Ruler = {
  active: false,
  points: [],
  finished: false,
  cursor: null,
  group: null,
  rubber: null,
  live: null,

  init() { this.group = L.layerGroup().addTo(MapView.map); },

  toggle(on = !this.active) {
    if (on === this.active) { if (!on) this.clear(); return; }
    this.active = on;
    if (on) {
      if (App.modMode) { Tools.cancelDraw(); Tools.stopEdit(); Tools.set('select'); }
      MapView.setHover(null);
      toast('Линейка: клики ставят точки · двойной клик или Enter — завершить · Esc — очистить', 'info', 4500);
    } else {
      this.clear();
    }
    document.body.classList.toggle('ruler-on', on);
    $('#btn-ruler').setAttribute('aria-pressed', String(on));
    Tools.sync();
  },
  clear() {
    this.points = [];
    this.finished = false;
    this.cursor = null;
    this.group?.clearLayers();
    this.rubber = null;
    this.live = null;
  },
  total(pts = this.points) { let s = 0; for (let i = 1; i < pts.length; i++) s += pts[i - 1].distanceTo(pts[i]); return s / 1000; },

  addPoint(ll) {
    if (this.finished) this.clear();
    const last = this.points[this.points.length - 1], map = MapView.map;
    if (last && map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(ll)) < 4) return;
    this.points.push(ll);
    this.render();
  },
  undoPoint() { if (!this.finished) { this.points.pop(); this.render(); } },
  finish() {
    if (this.points.length < 2) { this.clear(); return; }
    this.finished = true;
    this.cursor = null;
    this.render();
  },
  onMove(ll) {
    if (!this.active || this.finished || !this.points.length) return;
    this.cursor = ll;
    this.updateLive();
  },

  _label(ll, html, cls = '') {
    return L.marker(ll, {
      icon: L.divIcon({ className: `ruler-label ${cls}`, html: `<span>${html}</span>`, iconSize: null }),
      interactive: false, keyboard: false, pane: 'editPane',
    });
  },
  render() {
    const g = this.group, pts = this.points;
    g.clearLayers();
    this.rubber = null; this.live = null;
    if (!pts.length) return;
    const o = { renderer: MapView.overlayRenderer, pane: 'draftPane', interactive: false };
    const path = [];
    for (let i = 1; i < pts.length; i++) path.push(...greatCirclePath(pts[i - 1], pts[i]));
    if (path.length) {
      L.polyline(path, { ...o, color: '#1b1813', weight: 5, opacity: 0.35 }).addTo(g);
      L.polyline(path, { ...o, color: '#ffffff', weight: 2.5, dashArray: '8 6', opacity: 1 }).addTo(g);
    }
    let sum = 0;
    pts.forEach((p, i) => {
      L.circleMarker(p, { ...o, radius: i === 0 || (this.finished && i === pts.length - 1) ? 5.5 : 4, color: '#1b1813', weight: 2, fillColor: '#ffffff', fillOpacity: 1 }).addTo(g);
      if (i === 0) { this._label(p, 'Старт', 'start').addTo(g); return; }
      const seg = pts[i - 1].distanceTo(p) / 1000;
      sum += seg;
      const isLast = this.finished && i === pts.length - 1;
      this._label(p, isLast
        ? `<b>Итого: ${fmtKm(sum)}</b><small>+${fmtKm(seg)}</small>`
        : `+${fmtKm(seg)}<small>Σ ${fmtKm(sum)}</small>`, isLast ? 'total' : '').addTo(g);
    });
    this.rubber = L.polyline([], { ...o, color: '#ffffff', weight: 2, dashArray: '3 6', opacity: 0.85 }).addTo(g);
    this.updateLive();
  },
  updateLive() {
    if (!this.rubber) return;
    const last = this.points[this.points.length - 1];
    if (this.finished || !this.cursor || !last) {
      this.rubber.setLatLngs([]);
      if (this.live) { this.group.removeLayer(this.live); this.live = null; }
      return;
    }
    this.rubber.setLatLngs(greatCirclePath(last, this.cursor));
    const seg = last.distanceTo(this.cursor) / 1000, html = `+${fmtKm(seg)}<small>Σ ${fmtKm(this.total() + seg)}</small>`;
    if (!this.live) this.live = this._label(this.cursor, html, 'live').addTo(this.group);
    else { this.live.setLatLng(this.cursor); this.live.getElement().firstChild.innerHTML = html; }
  },
};

/* ───────────────────────────── 7. MAP VIEW ───────────────────────────── */
const Prefs = Object.assign(
  { labels: true, grid: true, capitals: true, base: CONFIG.tiles[0].name, sidebar: window.innerWidth > 900 },
  kv.get(LS, CONFIG.keys.ui, {}),
);
const savePrefs = () => kv.set(LS, CONFIG.keys.ui, Prefs);

/*
 * Слои снизу вверх:
 *   silhouettePane 390 — силуэты стран (заливка и контур), неинтерактивно
 *   blocPane       395 — общий внешний контур «сюзерен + вассалы»
 *   provincesPane  400 — провинции и особые зоны: прозрачные, но ловят мышь (тултипы, кисть, клики);
 *                        при включённой сетке рисуют тонкие линии провинций
 *   draftPane      450 — черновик полигона, контур редактируемой зоны, неинтерактивно
 *   labelsPane     550 — подписи государств
 *   markerPane     600 — столицы
 *   editPane       660 — вершины редактора и «магнит» привязки
 */
const MapView = {
  map: null,
  renderer: null,
  overlayRenderer: null,
  provinceGroup: null,
  customGroup: null,
  capitalsGroup: null,
  labelsGroup: null,
  layerById: new Map(),
  customById: new Map(),
  metaById: new Map(),
  labels: new Map(),       // cid → { marker, el, text, dependent, bbox }
  cityMarkers: new Map(),  // `${cid}:${cityId}` → L.Marker ('__capital' — столица)
  hoverLayer: null,
  hoverLatLng: null,
  selected: null,
  tip: null,

  init() {
    L.Map.mergeOptions({ preferCanvas: true });          // глобально для всех карт
    const map = this.map = L.map('map', {
      preferCanvas: true,
      zoomControl: false,
      minZoom: 2,
      maxZoom: 18,
      worldCopyJump: true,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 100,
    });

    const pane = (name, z, events) => { const p = map.createPane(name); p.style.zIndex = z; if (!events) p.style.pointerEvents = 'none'; return p; };
    pane('silhouettePane', 390, false);
    pane('blocPane', 395, false);
    pane('provincesPane', 400, true);
    pane('draftPane', 450, false);
    pane('labelsPane', 550, false);
    pane('editPane', 660, true);
    this.renderer = L.canvas({ pane: 'provincesPane', padding: 0.5, tolerance: 2 });
    this.overlayRenderer = L.canvas({ pane: 'draftPane', padding: 0.5 });
    Silhouettes.init(map);

    const bases = {};
    for (const t of CONFIG.tiles) bases[t.name] = L.tileLayer(t.url, t.options);
    (bases[Prefs.base] || bases[CONFIG.tiles[0].name]).addTo(map);
    map.on('baselayerchange', (e) => { Prefs.base = e.name; savePrefs(); });

    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.layers(bases, null, { position: 'bottomright' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

    this.provinceGroup = L.featureGroup().addTo(map);
    this.customGroup   = L.featureGroup().addTo(map);
    this.capitalsGroup = L.layerGroup().addTo(map);
    this.labelsGroup   = L.layerGroup().addTo(map);
    this.tip = L.tooltip({ direction: 'top', offset: [0, -10], className: 'hover-tip', opacity: 1 });

    for (const g of [this.provinceGroup, this.customGroup]) this._bindGroup(g);
    map.on('click', (e) => Tools.onPointer(e, null));
    map.on('mousedown', (e) => Tools.onPointerDown(e, null));
    map.on('dblclick', () => Tools.onDblClick());
    map.on('zoomend', () => { this.updateLabelSizes(); this.updateZoomClasses(); });
    this.updateZoomClasses();
    this.applyLabelToggle();
    // шрифты (Cinzel / Cormorant SC) догружаются асинхронно — тогда ширины текста пересчитываются
    document.fonts?.addEventListener?.('loadingdone', () => { labelWidthCache.clear(); this.updateLabelSizes(); });

    map.setView(CONFIG.initialView.center, CONFIG.initialView.zoom);
  },

  _bindGroup(group) {
    const L_ = (e) => e.propagatedFrom || e.layer;
    group.on('mouseover', (e) => { if (!Ruler.active) this.setHover(L_(e), e.latlng); Tools.onHover(L_(e)); });
    group.on('mouseout',  (e) => { if (this.hoverLayer === L_(e)) this.setHover(null); });
    group.on('mousemove', (e) => { if (this.hoverLayer) this.tip.setLatLng(e.latlng); });
    group.on('click',     (e) => Tools.onPointer(e, L_(e)));
    group.on('mousedown', (e) => Tools.onPointerDown(e, L_(e)));
    group.on('dblclick',  () => Tools.onDblClick());
    group.on('contextmenu', (e) => Tools.onContext(e, L_(e)));
  },

  /* — стили: заливку страны даёт силуэт, сами провинции и зоны прозрачны — */
  provinceStyle(fid) {
    const c = Store.country(Store.owner(fid));
    return {
      stroke: Prefs.grid,
      color: c ? shade(countryColor(c), -0.45) : '#3b3b3b',
      weight: c ? 0.6 : 0.5,
      opacity: c ? 0.55 : 0.4,
      fill: true,
      fillColor: '#f4efe2',
      fillOpacity: c ? 0 : 0.05,
    };
  },
  customStyle(id) {
    const f = Store.findCustom(id), c = Store.country(f?.properties.countryId);
    const noTurf = !hasTurf();                       // без Turf — запасной режим: зона красится сама
    return {
      stroke: App.modMode,                           // игрок видит только силуэт страны
      color: c ? shade(countryColor(c), -0.6) : '#ffffff',
      weight: 1.3, opacity: 0.9, dashArray: '5 4',
      fill: true,
      fillColor: c ? countryColor(c) : '#ffffff',
      fillOpacity: noTurf && c ? 0.55 : 0,
    };
  },
  _withHover(st) {
    return { ...st, stroke: true, color: '#ffffff', weight: 2.2, opacity: 1, dashArray: null, fillColor: '#ffffff', fillOpacity: 0.14 };
  },

  restyle(layer) {
    if (!layer?._rp) return;
    const { kind, id } = layer._rp;
    let st = kind === 'province' ? this.provinceStyle(id) : this.customStyle(id);
    if (layer === this.hoverLayer) { st = this._withHover(st); this.tip.setContent(this.tipHtml(layer)); }
    layer.setStyle(st);
  },
  restyleProvinces(fids) {
    if (!fids) this.layerById.forEach((l) => this.restyle(l));
    else for (const fid of fids) this.restyle(this.layerById.get(fid));
  },
  restyleCustoms() { this.customById.forEach((l) => this.restyle(l)); },

  /* — hover-подсказка (одна на всю карту) — */
  setHover(layer, latlng) {
    const prev = this.hoverLayer;
    if (prev === layer) return;
    this.hoverLayer = layer || null;
    this.hoverLatLng = latlng || null;
    if (prev) this.restyle(prev);
    if (layer) {
      this.restyle(layer);
      if (latlng) this.tip.setLatLng(latlng);
      if (!this.tip.isOpen() && this.tip.getLatLng()) this.tip.openOn(this.map);
    } else if (this.tip.isOpen()) {
      this.map.closeTooltip(this.tip);
    }
  },
  /** Провинция под точкой — для зон: тултип показывает реальный регион под ней. */
  provinceAt(latlng) {
    if (!latlng) return null;
    const p = this.map.latLngToLayerPoint(latlng);
    let hit = null;
    for (const [fid, l] of this.layerById) {
      if (!l._pxBounds || !l._pxBounds.contains(p)) continue;
      try { if (l._containsPoint(p)) hit = fid; } catch { /* слой ещё не спроецирован */ }
    }
    return hit ? Geo.byId.get(hit) : null;
  },
  /** Единый тултип государства: и для провинций, и для особых зон. */
  tipHtml(layer) {
    const { kind, id } = layer._rp;
    let owner, region = '', base = '', zone = '';
    if (kind === 'province') {
      const f = Geo.byId.get(id);
      owner = Store.country(Store.owner(id)); region = provinceName(f); base = provinceCountry(f);
    } else {
      const z = Store.findCustom(id), under = this.provinceAt(this.hoverLatLng);
      owner = Store.country(z?.properties.countryId);
      region = z?.properties.name || (under ? provinceName(under) : '');
      base = under ? provinceCountry(under) : '';
      if (App.modMode) zone = owner ? 'особая зона' : 'нейтральная зона';
    }
    const head = owner
      ? `<span class="dot" style="background:${countryColor(owner)}"></span><b>${esc(owner.name)}</b>`
      : '<span class="dot neutral"></span><b>Ничейная земля</b>';
    const lord = owner && Store.country(owner.overlordId);
    const real = App.modMode && base ? `<span class="tt-real">(${esc(base)})</span>` : '';
    const sub = [region ? esc(region) : '', real].filter(Boolean).join(' ');
    return `<div class="tt-head">${head}</div>` +
      (lord ? `<div class="tt-dep">${esc(depLabel(owner))} · ${esc(lord.name)}</div>` : '') +
      (sub ? `<div class="tt-region">${sub}</div>` : '') +
      (zone ? `<div class="tt-zone">${zone}</div>` : '');
  },

  /* — отрисовка — */
  renderProvinces() {
    const map = this.map;
    this.setHover(null);
    map.removeLayer(this.provinceGroup);
    map.removeLayer(this.customGroup);      // зоны должны остаться поверх провинций → добавим после
    this.provinceGroup.clearLayers();
    this.layerById.clear();
    this.metaById.clear();
    Silhouettes.reset();                    // id провинций могли смениться — кэш силуэтов недействителен

    const base = { renderer: this.renderer, pane: 'provincesPane', bubblingMouseEvents: false, smoothFactor: 1 };
    for (const f of Geo.features) {
      const t = f.geometry?.type;
      if (t !== 'Polygon' && t !== 'MultiPolygon') continue;
      const fid = f.properties.__fid;
      const layer = L.GeoJSON.geometryToLayer(f, { ...base, ...this.provinceStyle(fid) });
      layer.feature = f;
      layer._rp = { kind: 'province', id: fid };
      this.layerById.set(fid, layer);
      this.provinceGroup.addLayer(layer);
    }
    this.provinceGroup.addTo(map);
    this.customGroup.addTo(map);
  },

  renderCustom() {
    if (this.hoverLayer?._rp?.kind === 'custom') this.setHover(null);
    this.customGroup.clearLayers();
    this.customById.clear();
    for (const f of Store.state.customPolygons) {
      const layer = L.GeoJSON.geometryToLayer(f, {
        renderer: this.renderer, pane: 'provincesPane', bubblingMouseEvents: false, ...this.customStyle(f.id),
      });
      layer._rp = { kind: 'custom', id: f.id };
      this.customById.set(f.id, layer);
      this.customGroup.addLayer(layer);
    }
  },

  /**
   * Столицы (12px, жёлтые) и крупные города (7px, белые). Размер в пикселях фиксирован —
   * при отдалении метки не растут; видимость подписей и городов задаёт CSS по классам зума.
   */
  renderCapitals() {
    this.capitalsGroup.clearLayers();
    this.cityMarkers.clear();
    if (!Prefs.capitals) return;
    const add = (c, key, p, name, kind) => {
      const cap = kind === 'capital', size = cap ? 12 : 7;
      const marker = L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: `settlement ${kind}`, iconSize: [size, size], iconAnchor: [size / 2, size / 2],
          html: `<span class="pin">${cap ? '<i class="fa-solid fa-star"></i>' : ''}</span><span class="pin-label">${esc(name)}</span>`,
        }),
        keyboard: false, riseOnHover: true, zIndexOffset: cap ? 400 : 0,
      })
        .bindTooltip(`<b>${esc(name)}</b><br>${cap ? 'Столица' : 'Город'} · ${esc(c.name)}`, { direction: 'top', offset: [0, -size / 2 - 3], className: 'cap-tip' })
        .on('click', () => UI.openCountry(c.id))
        .addTo(this.capitalsGroup);
      this.cityMarkers.set(`${c.id}:${key}`, marker);
    };
    for (const c of Object.values(Store.state.countries)) {
      for (const city of c.cities) if (hasPoint(city)) add(c, city.id, city, city.name, 'city');
      if (hasPoint(c.capital)) add(c, '__capital', c.capital, c.capital.name || 'Столица', 'capital');
    }
  },
  /** z-far (< 4): столица 8px, без подписей и городов · z-mid (≥ 4): подписи столиц, точки городов · z-near (≥ 5): подписи городов. */
  updateZoomClasses() {
    const z = this.map.getZoom(), el = this.map.getContainer();
    el.classList.toggle('z-far', z < 4);
    el.classList.toggle('z-mid', z >= 4);
    el.classList.toggle('z-near', z >= 5);
  },
  /** Плавно подлететь к городу и подсветить его метку и тултип. cityId '__capital' — столица. */
  focusCity(cid, cityId) {
    const c = Store.country(cid);
    if (!c) return;
    const p = cityId === '__capital' ? c.capital : c.cities.find((x) => x.id === cityId);
    if (!hasPoint(p)) { this.flyToCountry(cid); return; }
    this.map.flyTo([p.lat, p.lng], Math.max(6, this.map.getZoom()), { duration: 0.9 });
    this.map.once('moveend', () => {
      const m = this.cityMarkers.get(`${cid}:${cityId}`);
      if (!m || !this.capitalsGroup.hasLayer(m)) return;
      m.openTooltip();
      const el = m.getElement();
      el?.classList.add('is-focus');
      setTimeout(() => el?.classList.remove('is-focus'), 2800);
    });
  },

  meta(fid) {
    let m = this.metaById.get(fid);
    if (!m) {
      const b = this.layerById.get(fid).getBounds(), c = b.getCenter();
      const area = Math.abs((b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest()) * Math.cos(c.lat * Math.PI / 180));
      m = { bounds: b, center: c, area };
      this.metaById.set(fid, m);
    }
    return m;
  },

  /**
   * Подписи государств. DOM-элементы переиспользуются (без пересоздания при каждом изменении),
   * поэтому кегль и прозрачность меняются плавно через CSS-transition.
   */
  renderLabels() {
    const live = new Set();
    for (const c of Object.values(Store.state.countries)) {
      if (c.hideMapLabel) continue;
      const g = Silhouettes.geom(c.id);
      const anchor = g ? labelAnchor(g) : null;
      let ll, bbox = null;
      if (anchor) ({ ll, bbox } = anchor);
      else if (c.capital && Number.isFinite(c.capital.lat)) ll = [c.capital.lat, c.capital.lng];
      else continue;
      live.add(c.id);
      let lb = this.labels.get(c.id);
      if (!lb) {
        const marker = L.marker(ll, {
          icon: L.divIcon({ className: 'country-label', html: '<span class="is-hidden"></span>', iconSize: null }),
          interactive: false, keyboard: false, pane: 'labelsPane',
        }).addTo(this.labelsGroup);
        lb = { marker, el: marker.getElement().firstChild };
        this.labels.set(c.id, lb);
      } else {
        lb.marker.setLatLng(ll);
      }
      lb.text = c.name;
      lb.bbox = bbox;
      lb.dependent = !!c.overlordId;
      lb.el.textContent = c.name;
      lb.el.classList.toggle('is-dependent', lb.dependent);
    }
    for (const [cid, lb] of this.labels) {
      if (live.has(cid)) continue;
      this.labelsGroup.removeLayer(lb.marker);
      this.labels.delete(cid);
    }
    requestAnimationFrame(() => this.updateLabelSizes());      // новые подписи проявляются из opacity 0
  },

  /**
   * Кегль — по экранной ширине крупнейшего полигона страны на текущем зуме:
   * текст занимает ~78% его ширины, в пределах minPx…maxPx (у зависимых — ×0.78).
   * Слишком мелкая территория или не помещающийся текст → подпись плавно гаснет.
   */
  updateLabelSizes() {
    const map = this.map, z = map.getZoom(), cfg = CONFIG.labels;
    for (const lb of this.labels.values()) {
      const k = lb.dependent ? cfg.dependentScale : 1;
      let size, visible;
      if (lb.bbox) {
        const [w, s, e, n] = lb.bbox;
        const p1 = map.project([n, w], z), p2 = map.project([s, e], z);
        const pw = Math.abs(p2.x - p1.x), ph = Math.abs(p2.y - p1.y), unit = labelUnitWidth(lb.text);
        const raw = Math.min(pw * cfg.fill / unit, ph * 0.5);                // плоские страны — ещё и по высоте
        const min = Math.max(7.5, cfg.minPx * k), max = cfg.maxPx * k;
        size = clamp(raw * k, min, max);
        visible = pw >= cfg.minTerritoryPx && unit * min <= pw * cfg.overflow;
      } else {                                                                  // нет территории — подпись у столицы
        size = cfg.minPx * k;
        visible = z >= 5;
      }
      lb.el.style.fontSize = `${size.toFixed(1)}px`;
      lb.el.classList.toggle('is-hidden', !visible);
    }
  },
  /** Кнопка «Названия (A)»: слой подписей плавно гаснет/проявляется, а не пропадает. */
  applyLabelToggle() {
    this.map.getContainer().classList.toggle('labels-off', !Prefs.labels);
  },

  refreshAll() {
    this.restyleProvinces(null);
    this.renderCustom();
    this.renderCapitals();
    Silhouettes.rebuild();
    this.renderLabels();
  },

  setSelected(cid) {
    const prev = this.selected;
    cid = cid || null;
    if (prev === cid) return;
    this.selected = cid;
    Silhouettes.restyle([prev, cid].filter(Boolean));
  },

  countryBounds(cid) {
    const g = Silhouettes.geom(cid);
    if (g) { const b = geomBBox(g); return L.latLngBounds([b[1], b[0]], [b[3], b[2]]); }
    return null;
  },
  flyToCountry(cid) {
    const b = this.countryBounds(cid), c = Store.country(cid);
    if (b?.isValid()) this.map.flyToBounds(b, { padding: [60, 60], maxZoom: 7, duration: 0.8 });
    else if (c?.capital && Number.isFinite(c.capital.lat)) this.map.flyTo([c.capital.lat, c.capital.lng], 6, { duration: 0.8 });
  },
  flyToProvince(fid) {
    if (this.layerById.has(fid)) this.map.flyToBounds(this.meta(fid).bounds, { padding: [80, 80], maxZoom: 8, duration: 0.8 });
  },
};

/* ───────────────────────────── 8. TOOLS (модератор) ───────────────────────────── */
const Keys = { alt: false, shift: false };

const VERTEX_ICON = L.divIcon({ className: 'vtx', iconSize: [12, 12], iconAnchor: [6, 6] });
const MID_ICON = L.divIcon({ className: 'vtx-mid', iconSize: [10, 10], iconAnchor: [5, 5] });

/** Плоский список колец (массивов L.LatLng) из вложенных latlngs полигона Leaflet. */
function flatRings(latlngs) {
  if (!latlngs.length) return [];
  return latlngs[0] instanceof L.LatLng ? [latlngs] : latlngs.flatMap(flatRings);
}

const Tools = {
  tool: 'select',                // select | paint | erase | pick | draw | capital
  activeCountry: kv.get(SS, CONFIG.keys.active),
  dragBrush: false,
  snapOn: kv.get(LS, 'rpmap.snap', true) !== false,
  stroking: false,
  draw: { points: [], cursor: null, freehand: null, group: null, rubber: null },
  editing: null,                 // { id, rings: [{ pi, ri, pts: LatLng[] }], group, preview, tooMany }
  snapMarker: null,
  _snapType: null,
  _capital: null,
  _suppressClick: false,
  _raf: 0,
  _lastMove: null,

  init() {
    const c = MapView.map.getContainer();
    c.addEventListener('mousemove', (ev) => {
      this._lastMove = ev;
      if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.onMove(this._lastMove); });
    });
    c.addEventListener('mousedown', (ev) => this.onNativeDown(ev), true);   // capture: раньше перетаскивания карты
    c.addEventListener('mouseleave', () => this.hideSnap());
    document.addEventListener('mouseup', (ev) => this.onNativeUp(ev));
    MapView.map.on('zoomend', () => this.updateRubber());
  },

  set(tool) {
    if (!App.modMode && tool !== 'select') return;
    if (tool !== 'select' && Ruler.active) Ruler.toggle(false);
    if (this.tool === 'draw' && tool !== 'draw') this.cancelDraw();
    if (tool !== 'select') this.stopEdit();
    if (this.tool === 'capital' && tool !== 'capital') this._capital = null;
    this.tool = tool;
    this.sync();
  },
  sync() {
    const m = MapView.map;
    const brushing = this.dragBrush && (this.tool === 'paint' || this.tool === 'erase') && !Ruler.active;
    const drawing = this.tool === 'draw';
    brushing ? m.dragging.disable() : m.dragging.enable();
    drawing || Ruler.active ? m.doubleClickZoom.disable() : m.doubleClickZoom.enable();
    drawing ? m.boxZoom.disable() : m.boxZoom.enable();          // Shift+тянуть — наше лассо, а не зум-рамка
    if (!drawing && !this.editing) this.hideSnap();
    m.getContainer().dataset.tool = this.tool;
    UI.syncToolbar();
  },
  setActive(cid, switchToPaint = false) {
    this.activeCountry = cid === NEUTRAL ? NEUTRAL : Store.country(cid) ? cid : null;
    kv.set(SS, CONFIG.keys.active, this.activeCountry);
    if (switchToPaint && this.activeCountry) this.set('paint'); else UI.syncToolbar();
    if (this.tool === 'draw') this.renderDraft();
  },
  /** id для записи в данные: NEUTRAL → null. */
  activeOwnerId() { return this.activeCountry === NEUTRAL ? null : this.activeCountry; },
  activeColor() {
    if (this.activeCountry === NEUTRAL) return '#ffffff';
    const c = Store.country(this.activeCountry);
    return c ? countryColor(c) : '#f0c36d';
  },
  toggleSnap(v = !this.snapOn) {
    this.snapOn = v;
    kv.set(LS, 'rpmap.snap', v);
    if (!v) this.hideSnap();
    UI.syncToolbar();
  },

  /* — события указателя (Leaflet) — */
  onPointer(e, layer) {
    if (this._suppressClick) { this._suppressClick = false; return; }
    if (Ruler.active) { Ruler.addPoint(e.latlng); return; }      // линейка: клики не открывают карточки
    const r = layer?._rp;
    switch (this.tool) {
      case 'select':
        if (!r) { this.stopEdit(); UI.closeInfo(); return; }
        if (r.kind === 'province') { this.stopEdit(); UI.openProvince(r.id); return; }
        UI.openCustom(r.id, { latlng: e.latlng });
        if (App.modMode) this.startEdit(r.id);
        return;
      case 'paint':
      case 'erase':
        if (!this.dragBrush && layer) this.apply(layer);
        return;
      case 'pick': {
        if (!r) return;
        const owner = r.kind === 'province' ? Store.owner(r.id) : Store.findCustom(r.id)?.properties.countryId;
        if (owner) { this.setActive(owner, true); toast(`Активно: ${Store.country(owner).name}`, 'ok', 1800); }
        else if (r.kind === 'custom') { this.setActive(NEUTRAL, true); toast('Активно: нейтральная территория', 'ok', 1800); }
        else toast('Эта территория ничья', 'warn', 1800);
        return;
      }
      case 'draw': this.addVertexAt(e.latlng, e.originalEvent); return;
      case 'capital': this.finishPointPick(e.latlng); return;
      case 'rename': if (layer) this.openRename(layer, e.latlng); return;
    }
  },
  onPointerDown(e, layer) {
    if (Ruler.active) return;
    if (!this.dragBrush || (this.tool !== 'paint' && this.tool !== 'erase')) return;
    if (e.originalEvent && e.originalEvent.button !== 0) return;
    if (layer?._rp.kind === 'custom' && this.tool === 'erase') { this.apply(layer); return; }
    this.stroking = true;
    Store.beginBatch();
    if (layer) this.apply(layer);
  },
  onHover(layer) { if (this.stroking && layer) this.apply(layer); },
  endStroke() { if (this.stroking) { this.stroking = false; Store.endBatch(); } },
  /** ПКМ по провинции/зоне в режиме модератора — переименование. */
  onContext(e, layer) {
    if (!App.modMode || Ruler.active || this.tool === 'draw' || !layer) return;
    L.DomEvent.preventDefault(e.originalEvent);
    this.openRename(layer, e.latlng);
  },
  /** Мини-попап переименования прямо над провинцией. */
  openRename(layer, latlng) {
    const { kind, id } = layer._rp, map = MapView.map;
    let current, orig, hint;
    if (kind === 'province') {
      const f = Geo.byId.get(id);
      current = provinceName(f); orig = provinceOrigName(f);
      hint = `Исходно: ${orig}${provinceCountry(f) ? ` (${provinceCountry(f)})` : ''} · ID ${id}`;
    } else {
      const z = Store.findCustom(id);
      current = z?.properties.name || ''; orig = ''; hint = z?.properties.countryId ? 'Особая зона' : 'Нейтральная зона';
    }
    let popup;
    const close = () => map.closePopup(popup);
    const input = h('input', { class: 'input', value: current, maxlength: 80, placeholder: orig || 'Название', 'aria-label': 'Новое название' });
    const save = () => {
      const v = input.value.trim();
      if (kind === 'province') Store.setProvinceName(id, v && v !== orig ? v : null);
      else Store.updateCustom(id, { name: v });
      close();
      toast(v ? `Название: «${v}»` : 'Название сброшено', 'ok', 1600);
    };
    const reset = () => { Store.setProvinceName(id, null); close(); toast(`Возвращено исходное: «${orig}»`, 'ok', 1600); };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();                         // не отдаём клавиши карте (стрелки, +/−)
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    const box = h('div', { class: 'rename-box' },
      h('div', { class: 'rb-title' }, ic('fa-solid fa-tag'), kind === 'province' ? ' Название провинции' : ' Название зоны'),
      h('div', { class: 'rb-hint' }, hint),
      input,
      h('div', { class: 'rb-actions' },
        h('button', { type: 'button', class: 'btn btn-small btn-accent', onclick: save }, ic('fa-solid fa-check'), ' Сохранить'),
        kind === 'province' && Store.provinceCustomName(id)
          ? h('button', { type: 'button', class: 'btn btn-small', onclick: reset }, ic('fa-solid fa-rotate-left'), ' Сбросить к исходному') : null,
        h('button', { type: 'button', class: 'btn btn-small', onclick: close }, 'Отмена')));
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    popup = L.popup({ className: 'rename-popup', closeButton: false, minWidth: 250, maxWidth: 320, autoPanPadding: [40, 40] })
      .setLatLng(latlng).setContent(box).openOn(map);
    setTimeout(() => { input.focus(); input.select(); }, 60);
  },

  onDblClick() {
    if (Ruler.active) Ruler.finish();
    else if (this.tool === 'draw') this.finishDraw();
  },

  apply(layer) {
    const { kind, id } = layer._rp;
    if (this.tool === 'paint') {
      if (!this.activeCountry) { if (!this.stroking) toast('Сначала выберите государство (или «Нейтральная территория»)', 'warn'); return; }
      const owner = this.activeOwnerId();
      if (kind === 'province') Store.setOwner(id, owner);
      else Store.updateCustom(id, { countryId: owner });
    } else if (this.tool === 'erase') {
      if (kind === 'province') Store.setOwner(id, null);
      else if (!this.stroking) {
        const f = Store.findCustom(id);
        if (confirm(`Удалить зону «${f?.properties.name || 'без названия'}»?`)) Store.removeCustom(id);
      }
    }
  },

  /* — нативные события мыши: привязка, лассо — */
  onMove(ev) {
    if (!ev) return;
    if (Ruler.active) { Ruler.onMove(MapView.map.mouseEventToLatLng(ev)); return; }
    if (this.tool !== 'draw') return;
    const map = MapView.map, ll = map.mouseEventToLatLng(ev);
    const fh = this.draw.freehand;
    if (fh) {
      const last = fh[fh.length - 1];
      if (map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(ll)) >= 3) { fh.push(ll); this.renderDraft(); }
      return;
    }
    const s = this.snapAt(ll, { alt: ev.altKey, draft: true });
    this.showSnap(s);
    this.draw.cursor = s ? s.latlng : ll;
    this.updateRubber();
  },
  onNativeDown(ev) {
    if (this.tool !== 'draw' || ev.button !== 0 || !ev.shiftKey) return;
    if (ev.target.closest('.leaflet-control, .leaflet-marker-icon')) return;
    ev.preventDefault();
    ev.stopPropagation();
    const ll = MapView.map.mouseEventToLatLng(ev);
    const s = this.snapAt(ll, { alt: ev.altKey });
    this.draw.freehand = [s ? s.latlng : ll];
    MapView.map.dragging.disable();
    this.hideSnap();
    this.renderDraft();
  },
  onNativeUp(ev) {
    this.endStroke();
    const fh = this.draw.freehand;
    if (!fh) return;
    this.draw.freehand = null;
    this._suppressClick = true;
    setTimeout(() => { this._suppressClick = false; }, 60);
    this.sync();
    let pts = fh;
    if (pts.length >= 3 && hasTurf()) {
      const tol = 1.5 * 360 / (256 * 2 ** MapView.map.getZoom());      // ≈1.5 px экрана в градусах
      try {
        const line = turf.simplify(turf.lineString(pts.map((p) => [p.lng, p.lat])), { tolerance: tol, highQuality: true });
        pts = line.geometry.coordinates.map(([x, y]) => L.latLng(y, x));
      } catch (e) { console.warn('[freehand] simplify', e); }
    }
    const endSnap = this.snapAt(fh[fh.length - 1], { alt: ev.altKey });
    if (endSnap && pts.length > 1) pts[pts.length - 1] = endSnap.latlng;
    this.draw.points.push(...pts);
    this.renderDraft();
  },

  /* — привязка к вершинам и рёбрам — */
  _snapRect(layer, z) {
    let c = layer._snap;
    if (!c || c.z !== z) {
      const b = layer.getBounds(), map = MapView.map;
      const nw = map.project(b.getNorthWest(), z), se = map.project(b.getSouthEast(), z);
      c = layer._snap = { z, minX: nw.x, minY: nw.y, maxX: se.x, maxY: se.y, rings: null };
    }
    return c;
  },
  _snapRings(layer, c) {
    if (!c.rings) {
      const map = MapView.map;
      c.rings = flatRings(layer.getLatLngs()).map((ring) => ring.map((ll) => { const q = map.project(ll, c.z); return { x: q.x, y: q.y, ll }; }));
    }
    return c.rings;
  },
  /**
   * Ближайшая вершина (приоритет) или точка на ребре провинций/зон в радиусе CONFIG.snapPx.
   * → { type: 'vertex' | 'edge' | 'close', latlng } или null. Alt — временно без привязки.
   */
  snapAt(latlng, { alt = Keys.alt, exclude = null, draft = false } = {}) {
    if (!this.snapOn || alt || !latlng) return null;
    const map = MapView.map, z = map.getZoom(), R = CONFIG.snapPx, p = map.project(latlng, z);
    const dpts = this.draw.points;
    if (draft && dpts.length >= 3 && map.project(dpts[0], z).distanceTo(p) <= R) return { type: 'close', latlng: dpts[0] };

    let bv = null, be = null;
    const scan = (layer) => {
      const c = this._snapRect(layer, z);
      if (p.x < c.minX - R || p.x > c.maxX + R || p.y < c.minY - R || p.y > c.maxY + R) return;
      for (const ring of this._snapRings(layer, c)) {
        const n = ring.length;
        for (let i = 0; i < n; i++) {
          const a = ring[i], b = ring[(i + 1) % n];
          const dv = Math.hypot(a.x - p.x, a.y - p.y);
          if (dv <= R && (!bv || dv < bv.d)) bv = { d: dv, ll: a.ll };
          const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
          if (!len2) continue;
          const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
          const de = Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
          if (de <= R && (!be || de < be.d)) be = { d: de, a: a.ll, b: b.ll, t };
        }
      }
    };
    MapView.layerById.forEach(scan);
    MapView.customById.forEach((l, id) => { if (id !== exclude) scan(l); });
    if (bv) return { type: 'vertex', latlng: bv.ll };
    if (be) {
      return {
        type: 'edge',
        latlng: L.latLng(round6(be.a.lat + be.t * (be.b.lat - be.a.lat)), round6(be.a.lng + be.t * (be.b.lng - be.a.lng))),
      };
    }
    return null;
  },
  showSnap(s) {
    if (!s) { this.hideSnap(); return; }
    const icon = () => L.divIcon({
      className: 'snap-marker', iconSize: [24, 24], iconAnchor: [12, 12],
      html: `<span class="snap-dot ${s.type}"><i class="fa-solid fa-magnet"></i></span>`,
    });
    if (!this.snapMarker) {
      this.snapMarker = L.marker(s.latlng, { icon: icon(), interactive: false, keyboard: false, pane: 'editPane' }).addTo(MapView.map);
    } else {
      this.snapMarker.setLatLng(s.latlng);
      if (this._snapType !== s.type) this.snapMarker.setIcon(icon());
    }
    this._snapType = s.type;
  },
  hideSnap() { if (this.snapMarker) { this.snapMarker.remove(); this.snapMarker = null; this._snapType = null; } },

  /* — рисование новой зоны: клики по точкам + Shift-лассо — */
  addVertexAt(latlng, ev) {
    const s = this.snapAt(latlng, { alt: ev?.altKey, draft: true });
    if (s?.type === 'close') { this.finishDraw(); return; }
    const ll = s ? s.latlng : latlng, pts = this.draw.points, last = pts[pts.length - 1], map = MapView.map;
    if (last && map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(ll)) < 3) return;
    pts.push(ll);
    this.renderDraft();
  },
  popVertex() { this.draw.points.pop(); this.renderDraft(); },
  renderDraft() {
    const d = this.draw;
    if (!d.group) d.group = L.layerGroup().addTo(MapView.map);
    d.group.clearLayers();
    d.rubber = null;
    const pts = d.freehand ? d.points.concat(d.freehand) : d.points;
    if (pts.length) {
      const color = this.activeColor(), o = { renderer: MapView.overlayRenderer, pane: 'draftPane', interactive: false };
      if (pts.length >= 2) L.polygon(pts, { ...o, color, weight: 2, dashArray: '6 4', fillColor: color, fillOpacity: 0.22 }).addTo(d.group);
      if (d.points.length <= 400) {
        d.points.forEach((p, i) => L.circleMarker(p, { ...o, radius: i === 0 ? 6 : 3.5, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).addTo(d.group));
      }
      d.rubber = L.polyline([], { ...o, color: '#ffffff', weight: 1.5, dashArray: '3 5', opacity: 0.9 }).addTo(d.group);
      this.updateRubber();
    }
    UI.syncToolbar();
  },
  updateRubber() {
    const d = this.draw;
    if (!d.rubber) return;
    const pts = d.points;
    if (!pts.length || !d.cursor || d.freehand) { d.rubber.setLatLngs([]); return; }
    d.rubber.setLatLngs(pts.length >= 2 ? [pts[pts.length - 1], d.cursor, pts[0]] : [pts[0], d.cursor]);
  },
  finishDraw() {
    const pts = this.draw.points;
    if (pts.length < 3) { toast('Нужно минимум 3 точки', 'warn'); return; }
    if (!this.activeCountry) { toast('Выберите государство или «Нейтральная территория» — зона будет принадлежать ему', 'warn'); return; }
    const neutral = this.activeCountry === NEUTRAL;
    const name = prompt(neutral ? 'Название нейтральной зоны (можно оставить пустым):' : 'Название территории (можно оставить пустым):', '');
    if (name === null) return;                          // «Отмена» — продолжаем рисовать
    const geometry = latlngsToGeometry([[pts]]);
    if (!geometry) { toast('Не удалось построить полигон', 'error'); return; }
    Store.addCustom({
      type: 'Feature', id: uid('poly'),
      properties: { name: name.trim(), countryId: this.activeOwnerId() },
      geometry,
    });
    this.cancelDraw();
    toast(neutral ? 'Нейтральная зона вырезана' : 'Территория добавлена', 'ok');
  },
  cancelDraw() {
    this.draw.points = [];
    this.draw.freehand = null;
    this.draw.cursor = null;
    if (this.draw.group) this.draw.group.clearLayers();
    this.draw.rubber = null;
    this.hideSnap();
    UI.syncToolbar();
  },

  /* — редактор вершин особой зоны — */
  startEdit(id) {
    const f = Store.findCustom(id);
    if (!f) { this.stopEdit(); return; }
    if (this.editing && this.editing.id !== id) this.stopEdit();
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const rings = [];
    polys.forEach((poly, pi) => poly.forEach((ring, ri) => rings.push({ pi, ri, pts: ring.slice(0, -1).map(([x, y]) => L.latLng(y, x)) })));
    const total = rings.reduce((n, r) => n + r.pts.length, 0);
    const group = this.editing?.group || L.layerGroup().addTo(MapView.map);
    this.editing = { id, rings, group, preview: null, tooMany: total > CONFIG.maxEditVertices };
    this.renderEdit();
    UI.syncToolbar();
  },
  editLatLngs() {
    const polys = [];
    for (const r of this.editing.rings) (polys[r.pi] ||= [])[r.ri] = r.pts;
    return polys.map((rings) => rings.filter(Boolean));
  },
  renderEdit() {
    const ed = this.editing;
    if (!ed) return;
    ed.group.clearLayers();
    const zc = Store.country(Store.findCustom(ed.id)?.properties.countryId);
    const color = zc ? countryColor(zc) : '#ffffff';
    ed.preview = L.polygon(this.editLatLngs(), {
      renderer: MapView.overlayRenderer, pane: 'draftPane', interactive: false,
      color: '#ffffff', weight: 2, dashArray: '6 4', fillColor: color, fillOpacity: 0.18,
    }).addTo(ed.group);
    if (ed.tooMany) return;

    const snapDrag = (e) => {
      const s = this.snapAt(e.target.getLatLng(), { exclude: ed.id });
      if (s) e.target.setLatLng(s.latlng);
      this.showSnap(s);
    };
    for (const r of ed.rings) {
      r.pts.forEach((ll, i) => {
        L.marker(ll, { icon: VERTEX_ICON, draggable: true, pane: 'editPane', keyboard: false, autoPan: true })
          .on('drag', (e) => { snapDrag(e); r.pts[i] = e.target.getLatLng(); ed.preview.setLatLngs(this.editLatLngs()); })
          .on('dragend', () => { this.hideSnap(); this.commitEdit(); })
          .on('contextmenu', (e) => {
            L.DomEvent.preventDefault(e.originalEvent);
            if (r.pts.length <= 3) { toast('В контуре должно остаться минимум 3 вершины', 'warn'); return; }
            r.pts.splice(i, 1);
            this.commitEdit();
          })
          .addTo(ed.group);
      });
      r.pts.forEach((a, i) => {
        const b = r.pts[(i + 1) % r.pts.length];
        const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
        const mm = L.marker(mid, { icon: MID_ICON, draggable: true, pane: 'editPane', keyboard: false, title: 'Клик или перетаскивание — новая вершина' });
        mm.on('click', () => { if (mm._dragged) return; r.pts.splice(i + 1, 0, mid); this.commitEdit(); });
        mm.on('dragstart', () => { mm._dragged = true; });
        mm.on('drag', snapDrag);
        mm.on('dragend', (e) => { this.hideSnap(); r.pts.splice(i + 1, 0, e.target.getLatLng()); this.commitEdit(); });
        mm.addTo(ed.group);
      });
    }
  },
  commitEdit() {
    const ed = this.editing;
    if (!ed) return;
    const geometry = latlngsToGeometry(this.editLatLngs());
    if (!geometry) { toast('Некорректная геометрия — изменение отменено', 'warn'); this.startEdit(ed.id); return; }
    Store.setCustomGeometry(ed.id, geometry);           // событие 'custom' → onCustomChanged перерисует маркеры
  },
  onCustomChanged() {
    if (!this.editing) return;
    if (Store.findCustom(this.editing.id)) this.startEdit(this.editing.id);
    else this.stopEdit();
  },
  stopEdit() {
    if (!this.editing) return;
    this.editing.group.remove();
    this.editing = null;
    this.hideSnap();
    UI.syncToolbar();
  },

  /* — выбор точки на карте (столица, город) — */
  startPointPick(cb, message = 'Кликните по карте, чтобы указать точку (Esc — отмена)') {
    if (Ruler.active) Ruler.toggle(false);
    this._capital = { prevTool: this.tool === 'capital' ? 'select' : this.tool, cb };
    this.tool = 'capital';
    this.sync();
    toast(message, 'info');
  },
  finishPointPick(ll) {
    const c = this._capital;
    this._capital = null;
    this.tool = c?.prevTool || 'select';
    this.sync();
    if (c?.cb && ll) c.cb(ll);
  },
};

/* ───────────────────────────── 9. GITHUB ───────────────────────────── */
const GitHub = {
  cfg: { owner: '', repo: '', branch: 'main', path: CONFIG.stateFile, token: '', remember: false },

  /** На *.github.io владелец и репозиторий определяются по адресу страницы. */
  detect() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (!m) return {};
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return { owner: m[1], repo: seg && !seg.includes('.') ? seg : `${m[1]}.github.io` };
  },
  load() {
    const saved = kv.get(LS, CONFIG.keys.gh, {}) || {};
    const token = kv.get(LS, CONFIG.keys.token) || kv.get(SS, CONFIG.keys.token) || '';
    this.cfg = { ...this.cfg, ...this.detect(), ...saved, token, remember: !!saved.remember };
  },
  save(patch) {
    this.cfg = { ...this.cfg, ...patch };
    const { token, ...rest } = this.cfg;
    kv.set(LS, CONFIG.keys.gh, rest);
    kv.del(LS, CONFIG.keys.token); kv.del(SS, CONFIG.keys.token);
    if (token) kv.set(rest.remember ? LS : SS, CONFIG.keys.token, token);
  },
  ready() { const c = this.cfg; return !!(c.owner && c.repo && c.path && c.token); },

  async api(path, { method = 'GET', body, raw = false } = {}) {
    const r = await fetch(`https://api.github.com${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        Authorization: `Bearer ${this.cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json()).message || ''; } catch { /* noop */ }
      const human = {
        401: 'неверный или просроченный токен',
        403: 'нет прав (нужно Contents: Read and write) или превышен лимит запросов',
        404: 'репозиторий, ветка или файл не найдены (или токен не видит репозиторий)',
        409: 'конфликт версий — загрузите свежую версию',
        422: 'GitHub отклонил запрос',
      }[r.status] || 'ошибка GitHub API';
      const err = new Error(`${human} [${r.status}${detail ? ': ' + detail : ''}]`);
      err.status = r.status;
      throw err;
    }
    return raw ? r.text() : r.json();
  },
  contentsPath() {
    const { owner, repo, path } = this.cfg;
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  },
  async checkAccess() {
    const r = await this.api(`/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}`);
    return { fullName: r.full_name, push: r.permissions?.push, defaultBranch: r.default_branch };
  },
  /** → { sha, text } или null, если файла нет. Файлы > 1 МБ читаются через raw media type. */
  async getFile() {
    const q = `${this.contentsPath()}?ref=${encodeURIComponent(this.cfg.branch)}`;
    let meta;
    try { meta = await this.api(q); } catch (e) { if (e.status === 404) return null; throw e; }
    if (Array.isArray(meta)) throw new Error('Путь указывает на папку, а не на файл');
    const text = meta.encoding === 'base64' && meta.content ? b64ToUtf8(meta.content) : await this.api(q, { raw: true });
    return { sha: meta.sha, text };
  },
  async putFile(text, message, sha) {
    const body = { message, content: utf8ToB64(text), branch: this.cfg.branch };
    if (sha) body.sha = sha;
    const res = await this.api(this.contentsPath(), { method: 'PUT', body });
    return res.content.sha;
  },
};

/* ───────────────────────────── 10. UI ───────────────────────────── */
const UI = {
  current: null,      // что открыто в карточке: { type: 'country'|'province'|'custom', id }
  editingId: null,

  init() {
    // вкладки и панель
    $$('.tab').forEach((t) => t.addEventListener('click', () => this.showTab(t.dataset.tab)));
    $('#btn-toggle-sidebar').addEventListener('click', () => this.toggleSidebar());
    document.body.classList.toggle('sidebar-closed', !Prefs.sidebar);

    // переключатели слоёв
    $$('[data-pref]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(!!Prefs[btn.dataset.pref]));
      btn.addEventListener('click', () => this.togglePref(btn.dataset.pref));
    });

    $('#btn-mod').addEventListener('click', () => App.toggleMod());
    $('#btn-save').addEventListener('click', () => App.saveToGitHub());
    $('#btn-close-info').addEventListener('click', () => this.closeInfo());
    $('#country-filter').addEventListener('input', () => this.renderCountryList());
    $('#country-sort').value = Prefs.sort || 'name';
    $('#country-sort').addEventListener('change', (e) => { Prefs.sort = e.target.value; savePrefs(); this.renderCountryList(); });
    $('#hide-deps').checked = !!Prefs.hideDeps;
    $('#hide-deps').addEventListener('change', (e) => { Prefs.hideDeps = e.target.checked; savePrefs(); this.renderCountryList(); });
    $('#btn-ruler').addEventListener('click', () => Ruler.toggle());

    this.initSearch();
    this.initEditor();
    this.initData();
    this.initGitHub();
    this.initToolbar();

    Store.on('replaced', () => this.refreshAll());
    Store.on('countries', () => this.refreshAll());
    Store.on('owners', () => this.scheduleRefresh());
    Store.on('custom', () => this.scheduleRefresh());
    Store.on('dirty', (v) => this.setDirty(v));
    Store.on('history', () => this.syncHistory());
  },

  togglePref(key) {
    Prefs[key] = !Prefs[key]; savePrefs();
    $(`[data-pref="${key}"]`)?.setAttribute('aria-pressed', String(Prefs[key]));
    if (key === 'labels') MapView.applyLabelToggle();
    if (key === 'grid') MapView.restyleProvinces(null);
    if (key === 'capitals') MapView.renderCapitals();
  },

  refreshAll() {
    this.renderCountryList();
    this.fillCountrySelects();
    this.refreshInfo();
    this.renderDataStats();
    this.syncToolbar();
    this.syncHistory();
  },
  scheduleRefresh: debounce(() => { UI.renderCountryList(); UI.refreshInfo(); UI.renderDataStats(); }, 200),

  /* — панели — */
  showTab(name) {
    const tab = $(`.tab[data-tab="${name}"]`);
    if (!tab || (tab.classList.contains('mod-only') && !App.modMode)) name = 'countries';
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  },
  toggleSidebar(force) {
    Prefs.sidebar = force ?? !Prefs.sidebar; savePrefs();
    document.body.classList.toggle('sidebar-closed', !Prefs.sidebar);
  },
  openSidebar() { this.toggleSidebar(true); },

  /* — список государств — */
  renderCountryList() {
    const q = $('#country-filter').value.trim().toLowerCase();
    const sort = Prefs.sort || 'name';
    const counts = Store.provinceCounts();
    const list = $('#country-list');
    const all = Store.countryList();
    const items = all.filter((c) => (!q || c.name.toLowerCase().includes(q)) && !(Prefs.hideDeps && c.overlordId));
    // значение для сортировки и правой колонки списка
    const metric = {
      name:      { get: (c) => Silhouettes.area(c.id) || null, fmt: fmtArea },
      area:      { get: (c) => Silhouettes.area(c.id) || null, fmt: fmtArea },
      population:{ get: (c) => c.population, fmt: fmtPop },
      gdp:       { get: (c) => c.gdp, fmt: fmtGdp },
      provinces: { get: (c) => counts.get(c.id) || null, fmt: (n) => `${n} пр.` },
    }[sort] || { get: () => null, fmt: String };
    if (sort !== 'name') items.sort((a, b) => (metric.get(b) ?? -1) - (metric.get(a) ?? -1) || a.name.localeCompare(b.name, 'ru'));
    list.replaceChildren(...items.map((c) => {
      const lord = Store.country(c.overlordId), val = metric.get(c);
      return h('li', {
        class: 'country-item' + (c.id === MapView.selected ? ' active' : ''),
        dataset: { id: c.id },
        tabindex: 0,
        onclick: () => this.openCountry(c.id, { fly: true }),
        onkeydown: (e) => { if (e.key === 'Enter') this.openCountry(c.id, { fly: true }); },
      },
      h('span', { class: 'swatch', style: { background: countryColor(c) } }),
      this.flagImg(c, 'mini-flag'),
      h('span', { class: 'ci-main' },
        h('span', { class: 'ci-name' }, c.name),
        lord ? h('span', { class: 'ci-sub' }, `${depLabel(c)} · ${lord.name}`) : null),
      h('span', { class: 'ci-area', title: `Провинций: ${counts.get(c.id) || 0}` }, val != null ? metric.fmt(val) : '—'));
    }));
    if (!items.length) {
      const hidden = Prefs.hideDeps && all.some((c) => c.overlordId);
      list.append(h('li', { class: 'empty' }, q ? 'Ничего не найдено'
        : all.length && hidden ? 'Все государства — зависимые территории (снимите фильтр).'
        : App.modMode ? 'Государств пока нет — создайте первое во вкладке «Редактор».' : 'Государств пока нет.'));
    }
    const total = MapView.layerById.size;
    let owned = 0, area = 0, pop = 0, gdp = 0;
    counts.forEach((n) => (owned += n));
    for (const c of all) { area += Silhouettes.area(c.id); pop += c.population || 0; gdp += c.gdp || 0; }
    const hiddenDeps = Prefs.hideDeps ? all.filter((c) => c.overlordId).length : 0;
    $('#world-stats').textContent = total
      ? [`Государств: ${all.length}${hiddenDeps ? ` (зависимых скрыто: ${hiddenDeps})` : ''}`,
        `площадь: ${fmtArea(area)}`,
        pop ? `население: ${fmtPop(pop)}` : '',
        gdp ? `ВВП: ${fmtGdp(gdp)}` : '',
        `провинций распределено: ${owned} из ${total} (${Math.round(owned / total * 100)}%)`].filter(Boolean).join(' · ')
      : '';
  },

  flagImg(c, cls) {
    const src = safeHttpUrl(c.flagUrl, true);
    if (!src) return null;
    return h('img', { class: cls, src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() });
  },

  /* — карточка — */
  showInfo() { $('#info-panel').hidden = false; },
  closeInfo() {
    $('#info-panel').hidden = true;
    this.current = null;
    MapView.setSelected(null);
    App.setHash(null);
    $$('.country-item.active').forEach((x) => x.classList.remove('active'));
  },
  refreshInfo() {
    const cur = this.current;
    if (!cur || $('#info-panel').hidden) return;
    if (cur.type === 'country') Store.country(cur.id) ? this.openCountry(cur.id, { silent: true }) : this.closeInfo();
    else if (cur.type === 'province') this.openProvince(cur.id, { silent: true });
    else if (cur.type === 'custom') Store.findCustom(cur.id) ? this.openCustom(cur.id, { silent: true }) : this.closeInfo();
  },

  openCountry(cid, { fly = false, silent = false, context = null } = {}) {
    const c = Store.country(cid);
    if (!c) return;
    if (!silent || this.current?.type !== 'country') this.current = { type: 'country', id: cid };
    MapView.setSelected(cid);
    $('#info-content').replaceChildren(this.countryCard(c, context));
    this.showInfo();
    if (fly) MapView.flyToCountry(cid);
    if (!silent) App.setHash(`c=${cid}`);
    $$('.country-item').forEach((li) => li.classList.toggle('active', li.dataset.id === cid));
  },

  countryCard(c, context) {
    const n = Store.provinceCounts().get(c.id) || 0;
    // собственное значение + «(с владениями: …)», если у вассалов сумма > 0
    const withDeps = (get, fmt) => {
      const st = statWithDeps(c.id, get);
      if (!st.hasOwn && !st.depsSum) return null;
      return [st.hasOwn ? fmt(st.own) : '—', st.depsSum > 0 ? h('span', { class: 'dd-sub' }, `(с владениями: ${fmt(st.total)})`) : null];
    };
    const stats = [
      ['Столица', c.capital?.name],
      ['Население', withDeps(statPop, fmtPop)],
      ['ВВП', withDeps(statGdp, fmtGdp)],
      ['Площадь', withDeps((id) => Silhouettes.area(id) || null, fmtArea)],
      ['Провинций', `${n}`],
    ].filter(([, v]) => v);
    const hasCap = c.capital && Number.isFinite(c.capital.lat);
    const lord = Store.country(c.overlordId), vassals = Store.vassals(c.id);
    return h('div', { class: 'card' },
      h('div', { class: 'info-hero', style: { '--c': countryColor(c) } },
        this.flagImg(c, 'info-flag') || h('div', { class: 'info-flag placeholder' }, ic('fa-solid fa-flag')),
        h('div', { class: 'hero-text' },
          h('h2', null, c.name),
          context ? h('div', { class: 'muted small' }, ic('fa-solid fa-location-dot'), ' ', context) : null)),
      lord ? h('button', {
        class: 'overlord-badge', style: { '--oc': countryColor(lord) }, title: 'Открыть карточку сюзерена',
        onclick: () => this.openCountry(lord.id, { fly: true }),
      },
      ic('fa-solid fa-crown'),
      h('span', { class: 'ob-type' }, `${depLabel(c)} державы:`),
      this.flagImg(lord, 'ob-flag') || h('span', { class: 'swatch', style: { background: countryColor(lord) } }),
      h('b', null, lord.name),
      ic('fa-solid fa-chevron-right ob-arrow')) : null,
      h('dl', { class: 'stats' }, stats.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      vassals.length ? h('div', { class: 'block' },
        h('h3', null, ic('fa-solid fa-sitemap'), ` Зависимые территории · ${vassals.length}`),
        h('ul', { class: 'vassal-list' }, vassals.map((v) => h('li', {
          tabindex: 0,
          onclick: () => this.openCountry(v.id, { fly: true }),
          onkeydown: (e) => { if (e.key === 'Enter') this.openCountry(v.id, { fly: true }); },
        },
        this.flagImg(v, 'mini-flag') || h('span', { class: 'swatch', style: { background: countryColor(v) } }),
        h('span', { class: 'vl-main' }, h('span', { class: 'vl-name' }, v.name), h('span', { class: 'vl-type' }, depLabel(v))),
        h('span', { class: 'vl-area' }, Silhouettes.area(v.id) ? fmtArea(Silhouettes.area(v.id)) : ''))))) : null,
      c.cities.length ? h('div', { class: 'block' },
        h('h3', null, ic('fa-solid fa-city'), ' Крупнейшие города'),
        h('ul', { class: 'city-list' }, c.cities.map((city) => (hasPoint(city)
          ? h('li', {
            class: 'has-point', tabindex: 0, title: 'Показать на карте',
            onclick: () => MapView.focusCity(c.id, city.id),
            onkeydown: (e) => { if (e.key === 'Enter') MapView.focusCity(c.id, city.id); },
          }, h('span', { class: 'city-dot' }), h('span', { class: 'cl-name' }, city.name), ic('fa-solid fa-location-arrow cl-go'))
          : h('li', { class: 'no-point', title: 'Точка на карте не задана' }, h('span', { class: 'city-dot' }), h('span', { class: 'cl-name' }, city.name)))))) : null,
      c.description ? h('div', { class: 'block' },
        h('h3', null, ic('fa-solid fa-scroll'), ' Описание'),
        h('p', { class: 'desc' }, c.description)) : null,
      h('div', { class: 'info-actions' },
        c.tgLink ? h('a', { class: 'btn btn-tg', href: c.tgLink, target: '_blank', rel: 'noopener noreferrer' }, ic('fa-brands fa-telegram'), ' Telegram') : null,
        h('button', { class: 'btn', onclick: () => MapView.flyToCountry(c.id) }, ic('fa-solid fa-expand'), ' Показать'),
        hasCap ? h('button', { class: 'btn', onclick: () => MapView.map.flyTo([c.capital.lat, c.capital.lng], 7) }, ic('fa-solid fa-star'), ' Столица') : null,
        App.modMode ? h('button', { class: 'btn btn-accent', onclick: () => this.editCountry(c.id) }, ic('fa-solid fa-pen'), ' Редактировать') : null,
        App.modMode ? h('button', { class: 'btn', onclick: () => Tools.setActive(c.id, true) }, ic('fa-solid fa-paintbrush'), ' Кисть') : null));
  },

  openProvince(fid, { silent = false } = {}) {
    const f = Geo.byId.get(fid);
    if (!f) return;
    const owner = Store.owner(fid), name = provinceName(f), real = realCountryHint(f);
    if (owner) {
      this.openCountry(owner, { silent, context: real ? `${name} ${real}` : name });
      this.current = { type: 'province', id: fid };
      if (!silent) App.setHash(`p=${fid}`);
      return;
    }
    this.current = { type: 'province', id: fid };
    MapView.setSelected(null);
    const active = Store.country(Tools.activeCountry);
    $('#info-content').replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'info-hero neutral' },
        h('div', { class: 'info-flag placeholder' }, ic('fa-solid fa-mountain-sun')),
        h('div', { class: 'hero-text' }, h('h2', null, name), h('div', { class: 'muted small' }, 'Ничейная земля'))),
      App.modMode ? h('dl', { class: 'stats' },
        provinceCountry(f) ? [h('dt', null, 'Реальная страна'), h('dd', null, provinceCountry(f))] : null,
        Store.provinceCustomName(fid) ? [h('dt', null, 'Исходное название'), h('dd', null, provinceOrigName(f))] : null,
        h('dt', null, 'ID провинции'), h('dd', { class: 'mono' }, fid)) : null,
      App.modMode && active && Tools.activeCountry !== NEUTRAL ? h('div', { class: 'info-actions' },
        h('button', { class: 'btn btn-accent', onclick: () => Store.setOwner(fid, active.id) },
          ic('fa-solid fa-paintbrush'), ` Присвоить: ${active.name}`)) : null));
    this.showInfo();
    if (!silent) App.setHash(`p=${fid}`);
  },

  /** Особая зона: для игрока выглядит как обычная территория своего государства. */
  openCustom(id, { silent = false, latlng = null } = {}) {
    const f = Store.findCustom(id);
    if (!f) return;
    latlng = latlng || (this.current?.type === 'custom' && this.current.id === id ? this.current.latlng : null);
    const under = MapView.provinceAt(latlng);
    const region = f.properties.name || (under ? provinceName(under) : '');
    const context = [region, under ? realCountryHint(under) : ''].filter(Boolean).join(' ');
    const owner = Store.country(f.properties.countryId);
    if (owner) {
      this.openCountry(owner.id, { silent, context: context || null });
    } else {
      MapView.setSelected(null);
      $('#info-content').replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'info-hero neutral' },
          h('div', { class: 'info-flag placeholder' }, ic('fa-solid fa-mountain-sun')),
          h('div', { class: 'hero-text' }, h('h2', null, 'Ничейная земля'),
            context ? h('div', { class: 'muted small' }, ic('fa-solid fa-location-dot'), ' ', context) : null))));
      this.showInfo();
    }
    this.current = { type: 'custom', id, latlng };
    if (App.modMode) {
      $('#info-content .card').append(
        h('p', { class: 'zone-note small' }, ic('fa-solid fa-draw-polygon'), ' ',
          owner ? `Особая зона «${f.properties.name || 'без названия'}»` : `Нейтральная зона «${f.properties.name || 'без названия'}»`,
          ' — вершины можно двигать на карте.'),
        h('div', { class: 'info-actions' },
          h('button', { class: 'btn', onclick: () => Tools.startEdit(id) }, ic('fa-solid fa-bezier-curve'), ' Вершины'),
          h('button', { class: 'btn', onclick: () => {
            const name = prompt('Название зоны:', f.properties.name || '');
            if (name !== null) Store.updateCustom(id, { name: name.trim() });
          } }, ic('fa-solid fa-i-cursor'), ' Переименовать'),
          h('button', { class: 'btn btn-danger', onclick: () => {
            if (confirm('Удалить эту зону? (Ctrl+Z — отменить)')) { Tools.stopEdit(); Store.removeCustom(id); this.closeInfo(); }
          } }, ic('fa-solid fa-trash'), ' Удалить')));
    }
  },

  /* — поиск — */
  initSearch() {
    const input = $('#search-input'), ul = $('#search-results');
    let results = [];
    const pick = (r) => {
      ul.hidden = true; input.value = ''; input.blur();
      if (r.type === 'country') this.openCountry(r.id, { fly: true });
      else if (r.type === 'city') { this.openCountry(r.id); MapView.focusCity(r.id, r.cityId); }
      else { MapView.flyToProvince(r.id); this.openProvince(r.id); }
    };
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      results = [];
      if (q) {
        for (const c of Store.countryList()) {
          const color = countryColor(c);
          if (c.name.toLowerCase().includes(q)) results.push({ type: 'country', id: c.id, label: c.name, sub: '', color });
          if ((c.capital?.name || '').toLowerCase().includes(q)) results.push({ type: 'city', id: c.id, cityId: '__capital', label: c.capital.name, sub: `столица · ${c.name}`, color });
          for (const city of c.cities) {
            if (city.name.toLowerCase().includes(q)) results.push({ type: 'city', id: c.id, cityId: city.id, label: city.name, sub: `город · ${c.name}`, color });
          }
        }
        if (q.length >= 2) {
          for (const f of Geo.features) {
            const n = provinceName(f, false);
            const orig = App.modMode ? provinceOrigName(f, false) : '';        // модератор находит и по исходному имени
            if ((n && n.toLowerCase().includes(q)) || (orig && orig.toLowerCase().includes(q))) {
              const o = Store.country(Store.owner(f.properties.__fid));
              const sub = [o ? o.name : 'ничья', realCountryHint(f)].filter(Boolean).join(' ');
              results.push({ type: 'province', id: f.properties.__fid, label: n, sub, color: o ? countryColor(o) : null });
              if (results.length >= 30) break;
            }
          }
        }
      }
      results = results.slice(0, 12);
      ul.replaceChildren(...results.map((r) => h('li', { onmousedown: (e) => { e.preventDefault(); pick(r); } },
        ic(r.type === 'country' ? 'fa-solid fa-flag' : r.type === 'city' ? (r.cityId === '__capital' ? 'fa-solid fa-star' : 'fa-solid fa-city') : 'fa-solid fa-map-location-dot'),
        r.color ? h('span', { class: 'swatch', style: { background: r.color } }) : null,
        h('span', { class: 'sr-label' }, r.label),
        r.sub ? h('span', { class: 'sr-sub' }, r.sub) : null)));
      if (q && !results.length) ul.append(h('li', { class: 'empty' }, 'Ничего не найдено'));
      ul.hidden = !q;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && results[0]) pick(results[0]);
      if (e.key === 'Escape') { input.value = ''; ul.hidden = true; input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(() => (ul.hidden = true), 120));
  },

  /* — редактор государства — */
  initEditor() {
    const form = $('#country-form'), F = (n) => form.elements.namedItem(n);
    F('colorPicker').addEventListener('input', () => { F('color').value = F('colorPicker').value; });
    F('color').addEventListener('input', () => { const c = normColor(F('color').value); if (c) F('colorPicker').value = c; });
    F('flagUrl').addEventListener('input', debounce(() => this.updateFlagPreview(), 300));
    $('#editor-select').addEventListener('change', (e) => this.fillForm(Store.country(e.target.value)));
    $('#btn-new-country').addEventListener('click', () => this.fillForm(null));
    $('#dep-types').replaceChildren(...DEPENDENCY_TYPES.map((t) => h('option', { value: t })));
    F('overlordId').addEventListener('change', () => this.syncDependencyFields());
    $('#btn-pick-capital').addEventListener('click', () => {
      Tools.startPointPick((ll) => {
        F('capLat').value = round6(ll.lat).toFixed(4);
        F('capLng').value = round6(L.Util.wrapNum(ll.lng, [-180, 180], true)).toFixed(4);
        this.openSidebar(); this.showTab('editor');
        toast('Координаты столицы заполнены — нажмите «Применить»', 'ok');
      }, 'Кликните по карте, чтобы указать столицу (Esc — отмена)');
    });
    $('#btn-add-city').addEventListener('click', () => {
      this.cityRows.push({ id: uid('city'), name: '', lat: null, lng: null });
      this.renderCityRows();
      $$('#cities-editor .city-name').pop()?.focus();
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); this.applyForm(); });
    $('#btn-delete-country').addEventListener('click', () => this.deleteEditing());
    $('#btn-make-active').addEventListener('click', () => {
      if (this.editingId) Tools.setActive(this.editingId, true);
      else toast('Сначала примените (создайте) государство', 'warn');
    });
    this.fillForm(null);
  },
  /* — список «Крупнейшие города» в редакторе — */
  cityRows: [],
  renderCityRows() {
    const box = $('#cities-editor');
    box.replaceChildren(...this.cityRows.map((city, i) => {
      let row = null;
      const sync = () => row?.classList.toggle('has-point', hasPoint(city));
      const name = h('input', { class: 'input city-name', value: city.name, placeholder: 'Название города', maxlength: 60, 'aria-label': 'Название города' });
      name.addEventListener('input', () => { city.name = name.value; });
      const coord = (key) => {
        const inp = h('input', {
          class: 'input mono coord', value: Number.isFinite(city[key]) ? Number(city[key].toFixed(4)) : '', placeholder: key,
          inputmode: 'decimal', title: key === 'lat' ? 'Широта' : 'Долгота',
        });
        inp.addEventListener('input', () => {
          const v = parseFloat(inp.value.replace(',', '.'));
          city[key] = Number.isFinite(v) ? v : null;
          sync();
        });
        return inp;
      };
      row = h('div', { class: 'city-row' + (hasPoint(city) ? ' has-point' : '') },
        h('span', { class: 'city-dot', title: 'Метка на карте: задана / не задана' }),
        name, coord('lat'), coord('lng'),
        h('button', { type: 'button', class: 'btn btn-small icon-only', title: 'Указать на карте', onclick: () => this.pickCityPoint(city) }, ic('fa-solid fa-location-crosshairs')),
        h('button', { type: 'button', class: 'btn btn-small icon-only btn-danger', title: 'Удалить город', onclick: () => { this.cityRows.splice(i, 1); this.renderCityRows(); } }, '×'));
      return row;
    }));
    if (!this.cityRows.length) box.append(h('p', { class: 'muted small cities-empty' }, 'Городов пока нет.'));
  },
  pickCityPoint(city) {
    Tools.startPointPick((ll) => {
      city.lat = round6(ll.lat);
      city.lng = round6(L.Util.wrapNum(ll.lng, [-180, 180], true));
      if (!city.name.trim()) city.name = 'Новый город';
      this.openSidebar(); this.showTab('editor');
      this.renderCityRows();
      const c = Store.country(this.editingId);
      if (c) {                                   // у существующей страны метка появляется сразу
        Store.upsertCountry({ ...c, cities: this.cityRows.map((x) => ({ ...x, name: x.name.trim() })) });
        toast(`Город «${city.name}» отмечен на карте`, 'ok');
      } else {
        toast('Координаты города заполнены — нажмите «Применить», чтобы создать государство', 'ok');
      }
    }, `Кликните по карте, чтобы отметить город «${city.name.trim() || 'новый'}» (Esc — отмена)`);
  },

  nextCountryId() {
    let max = 0;
    for (const id of Object.keys(Store.state.countries)) { const m = id.match(/^country_(\d+)$/); if (m) max = Math.max(max, +m[1]); }
    return `country_${max + 1}`;
  },
  editCountry(cid) { this.openSidebar(); this.showTab('editor'); this.fillForm(Store.country(cid)); },
  fillForm(c) {
    const form = $('#country-form'), F = (n) => form.elements.namedItem(n);
    this.editingId = c ? c.id : null;
    const color = c?.color || colorFromString(uid('c'));
    F('id').value = c?.id || this.nextCountryId();
    F('id').readOnly = !!c;
    F('name').value = c?.name || '';
    F('color').value = color; F('colorPicker').value = color;
    F('flagUrl').value = c?.flagUrl || '';
    F('capName').value = c?.capital?.name || '';
    F('capLat').value = Number.isFinite(c?.capital?.lat) ? c.capital.lat : '';
    F('capLng').value = Number.isFinite(c?.capital?.lng) ? c.capital.lng : '';
    F('population').value = c?.population ?? '';
    F('gdp').value = c?.gdp ?? '';
    this.cityRows = (c?.cities || []).map((x) => ({ ...x }));
    this.renderCityRows();
    F('tgLink').value = c?.tgLink || '';
    F('description').value = c?.description || '';
    // сюзерен: без самой страны и без её вассалов (иначе цикл)
    const banned = c ? Store.allVassals(c.id).add(c.id) : new Set();
    F('overlordId').replaceChildren(
      h('option', { value: '' }, '— независимое государство —'),
      ...Store.countryList().filter((x) => !banned.has(x.id)).map((x) => h('option', { value: x.id }, x.name)));
    F('overlordId').value = c?.overlordId && !banned.has(c.overlordId) ? c.overlordId : '';
    F('dependencyType').value = c?.overlordId ? depLabel(c) : '';
    F('inheritOverlordColor').checked = c ? c.inheritOverlordColor !== false : true;
    F('hideMapLabel').checked = !!c?.hideMapLabel;
    this.syncDependencyFields();
    $('#editor-title').textContent = c ? `Редактирование: ${c.name}` : 'Новое государство';
    $('#btn-delete-country').hidden = !c;
    $('#editor-select').value = c?.id || '';
    this.updateFlagPreview();
  },
  syncDependencyFields() {
    const form = $('#country-form'), dep = !!form.elements.namedItem('overlordId').value;
    form.elements.namedItem('dependencyType').disabled = !dep;
    form.elements.namedItem('inheritOverlordColor').disabled = !dep;
    $('#dep-fields').classList.toggle('is-disabled', !dep);
    if (dep && !form.elements.namedItem('dependencyType').value) form.elements.namedItem('dependencyType').value = DEPENDENCY_TYPES[0];
  },
  updateFlagPreview() {
    const img = $('#flag-preview'), src = safeHttpUrl($('#country-form').elements.namedItem('flagUrl').value, true);
    img.hidden = !src;
    if (src) { img.onerror = () => (img.hidden = true); img.src = src; }
  },
  applyForm() {
    const form = $('#country-form'), F = (n) => form.elements.namedItem(n).value.trim();
    const id = F('id'), name = F('name');
    if (!name) { toast('Укажите название', 'warn'); return; }
    if (!/^[A-Za-z0-9_-]+$/.test(id)) { toast('ID: только латиница, цифры, «_» и «-»', 'warn'); return; }
    if (!this.editingId && Store.country(id)) { toast(`ID «${id}» уже занят`, 'warn'); return; }
    const color = normColor(F('color'));
    if (!color) { toast('Цвет должен быть в формате #rrggbb', 'warn'); return; }
    const lat = F('capLat') === '' ? NaN : parseFloat(F('capLat').replace(',', '.'));
    const lng = F('capLng') === '' ? NaN : parseFloat(F('capLng').replace(',', '.'));
    if ((F('capLat') !== '' && !Number.isFinite(lat)) || (F('capLng') !== '' && !Number.isFinite(lng))) {
      toast('Координаты столицы должны быть числами', 'warn'); return;
    }
    if (F('tgLink') && !cleanTgLink(F('tgLink'))) { toast('Ссылка Telegram не распознана (нужно https://t.me/… или @name)', 'warn'); return; }
    const num = (name, label) => {
      const raw = F(name).replace(',', '.');
      if (raw === '') return { v: null };
      const v = Number(raw);
      return Number.isFinite(v) && v >= 0 ? { v } : { err: `${label}: нужно неотрицательное число` };
    };
    const population = num('population', 'Население'), gdp = num('gdp', 'ВВП');
    if (population.err || gdp.err) { toast(population.err || gdp.err, 'warn'); return; }
    const overlordId = F('overlordId') || null;
    if (overlordId && overlordId === id) { toast('Государство не может зависеть само от себя', 'warn'); return; }
    if (overlordId && Store.wouldCycle(id, overlordId)) { toast('Нельзя: получится цикл зависимостей (сюзерен сам зависит от этой страны)', 'warn'); return; }
    const prev = Store.country(this.editingId) || {};
    const c = Store.upsertCountry({
      ...prev,
      id, name, color,
      flagUrl: F('flagUrl'),
      capital: { name: F('capName'), lat, lng },
      population: population.v, gdp: gdp.v,
      cities: this.cityRows.map((x) => ({ ...x, name: x.name.trim() })).filter((x) => x.name), tgLink: F('tgLink'), description: form.elements.namedItem('description').value,
      overlordId,
      dependencyType: overlordId ? F('dependencyType') || DEPENDENCY_TYPES[0] : '',
      inheritOverlordColor: form.elements.namedItem('inheritOverlordColor').checked,
      hideMapLabel: form.elements.namedItem('hideMapLabel').checked,
    });
    const isNew = !this.editingId;
    this.fillForm(c);
    if (isNew && !Tools.activeCountry) Tools.setActive(c.id);
    toast(isNew ? `Государство «${c.name}» создано` : 'Изменения применены', 'ok');
  },
  deleteEditing() {
    const c = Store.country(this.editingId);
    if (!c) return;
    const n = Store.provinceCounts().get(c.id) || 0;
    if (!confirm(`Удалить «${c.name}»?\n\nС ${n} ${plural(n, 'провинции', 'провинций', 'провинций')} будет снято владение, его полигоны будут удалены. Историю отмен это очистит.`)) return;
    if (Tools.activeCountry === c.id) Tools.setActive(null);
    if (this.current && MapView.selected === c.id) this.closeInfo();
    Store.deleteCountry(c.id);
    this.fillForm(null);
    toast('Государство удалено', 'ok');
  },
  fillCountrySelects() {
    const list = Store.countryList();
    const ed = $('#editor-select');
    ed.replaceChildren(h('option', { value: '' }, '— новое государство —'), ...list.map((c) => h('option', { value: c.id }, c.name)));
    ed.value = this.editingId && Store.country(this.editingId) ? this.editingId : '';
    if (this.editingId && !Store.country(this.editingId)) this.fillForm(null);

    const ac = $('#active-country');
    ac.replaceChildren(
      h('option', { value: '' }, '— государство —'),
      h('option', { value: NEUTRAL }, '⌀ Нейтральная территория (ластик зоны)'),
      ...list.map((c) => h('option', { value: c.id }, c.name)));
    if (Tools.activeCountry && Tools.activeCountry !== NEUTRAL && !Store.country(Tools.activeCountry)) Tools.activeCountry = null;
    ac.value = Tools.activeCountry || '';
  },

  /* — вкладка «Данные» — */
  initData() {
    $('#btn-export').addEventListener('click', () => downloadText(Store.serialize(), CONFIG.stateFile));
    $('#btn-import').addEventListener('click', async () => {
      const file = await pickFile($('#file-state'));
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data || typeof data !== 'object' || (!data.countries && !data.provinceOwners)) throw new Error('это не похоже на map-state.json');
        if (Store.dirty && !confirm('Текущие несохранённые изменения будут заменены. Продолжить?')) return;
        Store.replace(data, { sha: Store.sha, dirty: true });
        toast(`Импортировано: ${Object.keys(Store.state.countries).length} государств`, 'ok');
      } catch (e) { toast(`Ошибка импорта: ${e.message}`, 'error', 7000); }
    });
    $('#btn-load-grid').addEventListener('click', async () => {
      const file = await pickFile($('#file-provinces'));
      if (file) App.loadGridFile(file);
    });
    $('#btn-export-grid').addEventListener('click', () => {
      if (!Geo.features.length) { toast('Сетка ещё не загружена', 'warn'); return; }
      const text = Geo.exportGeoJSON();
      downloadText(text, CONFIG.provincesFile, 'application/geo+json');
      toast(`provinces.json: ${Geo.features.length} областей, ${fmtMB(new Blob([text]).size)}. Положите файл рядом с index.html.`, 'ok', 7000);
    });
    $('#btn-clear-cache').addEventListener('click', async () => {
      try {
        await Geo.clearCache();
        this.renderDataStats();
        if (confirm('Кэш сетки очищен. Перезагрузить страницу и скачать сетку ADM-1 заново?\n(Если в репозитории есть provinces.json, будет использован он.)')) location.reload();
        else toast('Кэш сетки очищен', 'ok');
      } catch (e) { toast(`Не удалось очистить кэш: ${e.message}`, 'error'); }
    });
    $('#btn-clean-orphans').addEventListener('click', () => {
      const orphans = Object.keys(Store.state.provinceOwners).filter((fid) => !Geo.byId.has(fid));
      if (!orphans.length) { toast('Осиротевших владений нет', 'ok'); return; }
      if (!confirm(`Удалить ${orphans.length} записей provinceOwners, которых нет в текущей сетке?`)) return;
      Store.setOwners(orphans.map((fid) => [fid, null]));
      toast(`Удалено: ${orphans.length}`, 'ok');
    });
    $('#btn-reset-owners').addEventListener('click', () => {
      const all = Object.keys(Store.state.provinceOwners);
      if (!all.length) return;
      if (!confirm(`Снять владение со всех ${all.length} провинций? (Можно отменить через Ctrl+Z)`)) return;
      Store.setOwners(all.map((fid) => [fid, null]));
    });
  },
  renderDataStats() {
    const owners = Object.keys(Store.state.provinceOwners);
    const orphans = owners.filter((fid) => Geo.byId.size && !Geo.byId.has(fid)).length;
    $('#grid-info').textContent =
      `Источник: ${Geo.source}. Полигонов: ${MapView.layerById.size}. ` +
      `Слияние силуэтов: ${Geo.topology ? 'topojson.merge' : 'turf.union (без топологии — медленнее)'}${hasTurf() ? ' + Turf' : ' — Turf.js не загрузился, зоны без вырезания'}. ` +
      `Своих полигонов: ${Store.state.customPolygons.length}. ` +
      `Переименовано провинций: ${Object.keys(Store.state.provinceNames).length}. ` +
      (orphans ? `⚠ Владений без провинции в сетке: ${orphans}.` : '');
    $('#btn-clean-orphans').disabled = !orphans;
    Geo.cacheInfo().then((m) => {
      $('#cache-info').textContent = m
        ? `Кэш браузера (IndexedDB): ${m.count} областей, сохранён ${new Date(m.savedAt).toLocaleString('ru-RU')}.`
        : 'Кэш браузера (IndexedDB): пуст.';
    });
  },

  /* — вкладка GitHub — */
  initGitHub() {
    const form = $('#gh-form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      GitHub.save(this.readGhForm());
      this.renderGhStatus();
      toast('Настройки GitHub сохранены', 'ok');
    });
    $('#btn-gh-check').addEventListener('click', async () => {
      GitHub.save(this.readGhForm());
      if (!GitHub.ready()) { toast('Заполните владельца, репозиторий, путь и токен', 'warn'); return; }
      try {
        const r = await GitHub.checkAccess();
        toast(`Доступ к ${r.fullName} есть${r.push === false ? ', но без права записи!' : ''}`, r.push === false ? 'warn' : 'ok', 5000);
      } catch (e) { toast(`Проверка не прошла: ${e.message}`, 'error', 7000); }
    });
    $('#btn-gh-save').addEventListener('click', () => { GitHub.save(this.readGhForm()); App.saveToGitHub(); });
    $('#btn-gh-load').addEventListener('click', () => { GitHub.save(this.readGhForm()); App.reloadFromGitHub(); });
    this.fillGhForm();
  },
  readGhForm() {
    const f = $('#gh-form').elements, v = (n) => f.namedItem(n).value.trim();
    return { owner: v('owner'), repo: v('repo'), branch: v('branch') || 'main', path: v('path') || CONFIG.stateFile, token: v('token'), remember: f.namedItem('remember').checked };
  },
  fillGhForm() {
    const f = $('#gh-form').elements, c = GitHub.cfg;
    for (const k of ['owner', 'repo', 'branch', 'path', 'token']) f.namedItem(k).value = c[k] || '';
    f.namedItem('remember').checked = !!c.remember;
    this.renderGhStatus();
  },
  renderGhStatus() {
    const c = GitHub.cfg;
    $('#gh-status').textContent = c.owner && c.repo
      ? `Цель: ${c.owner}/${c.repo} @ ${c.branch} → ${c.path}. Базовая версия: ${Store.sha ? Store.sha.slice(0, 7) : 'неизвестна'}.`
      : 'Репозиторий не указан.';
  },

  /* — тулбар модератора — */
  initToolbar() {
    $$('#toolbar [data-tool]').forEach((b) => b.addEventListener('click', () => Tools.set(b.dataset.tool)));
    // blur() — чтобы после выбора горячие клавиши снова работали
    $('#active-country').addEventListener('change', (e) => { Tools.setActive(e.target.value || null); e.target.blur(); });
    $('#drag-brush').addEventListener('change', (e) => { Tools.dragBrush = e.target.checked; Tools.sync(); e.target.blur(); });
    $('#btn-undo').addEventListener('click', () => Store.undo());
    $('#btn-redo').addEventListener('click', () => Store.redo());
    $('#btn-draw-finish').addEventListener('click', () => Tools.finishDraw());
    $('#btn-draw-cancel').addEventListener('click', () => Tools.cancelDraw());
    $('#btn-snap').addEventListener('click', () => Tools.toggleSnap());
    $('#btn-edit-done').addEventListener('click', () => Tools.stopEdit());
  },
  syncToolbar() {
    $$('#toolbar [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === Tools.tool));
    const c = Store.country(Tools.activeCountry), neutral = Tools.activeCountry === NEUTRAL;
    $('#active-swatch').style.background = c ? countryColor(c) : '';
    $('#active-swatch').classList.toggle('empty', !c && !neutral);
    $('#active-swatch').classList.toggle('neutral', neutral);
    $('#active-country').value = c ? c.id : neutral ? NEUTRAL : '';
    $('#btn-snap').setAttribute('aria-pressed', String(Tools.snapOn));
    $('#btn-snap').classList.toggle('active', Tools.snapOn);
    const ed = Tools.editing;
    $('#edit-controls').hidden = !ed;
    if (ed) {
      const z = Store.findCustom(ed.id);
      $('#edit-name').textContent = z?.properties.name || 'зона без названия';
      $('#edit-hint').textContent = ed.tooMany ? 'слишком много вершин для ручной правки' : 'тяните точки · ПКМ — удалить · ◦ — добавить';
    }
    $('#drag-brush').checked = Tools.dragBrush;
    $('#draw-controls').hidden = Tools.tool !== 'draw';
    const n = Tools.draw.points.length;
    $('#draw-count').textContent = `${n} ${plural(n, 'точка', 'точки', 'точек')}`;
  },
  syncHistory() {
    $('#btn-undo').disabled = !Store.undoStack.length;
    $('#btn-redo').disabled = !Store.redoStack.length;
  },
  setDirty(v) {
    $('#btn-save').classList.toggle('dirty', v);
    document.title = (v ? '• ' : '') + document.title.replace(/^• /, '');
  },
  setSaving(v) {
    for (const b of [$('#btn-save'), $('#btn-gh-save')]) {
      b.disabled = v;
      b.classList.toggle('busy', v);
    }
  },

  showDraftBanner(draft, onRestore, onDiscard) {
    const b = $('#draft-banner');
    const when = new Date(draft.savedAt).toLocaleString('ru-RU');
    const stale = draft.baseSha && Store.sha && draft.baseSha !== Store.sha;
    b.replaceChildren(
      ic('fa-solid fa-clock-rotate-left'),
      h('span', null, `Несохранённый черновик от ${when}.`, stale ? ' ⚠ С тех пор файл в репозитории изменился.' : ''),
      h('button', { class: 'btn btn-small btn-accent', onclick: () => { b.hidden = true; onRestore(); } }, 'Восстановить'),
      h('button', { class: 'btn btn-small', onclick: () => { b.hidden = true; onDiscard(); } }, 'Удалить'));
    b.hidden = false;
  },
};

/* ───────────────────────────── 11. APP ───────────────────────────── */
const App = {
  modMode: false,
  _saving: false,

  async init() {
    if (!window.L) { setLoader('Не удалось загрузить Leaflet (проверьте подключение к CDN)'); return; }
    MapView.init();
    Tools.init();
    Ruler.init();
    GitHub.load();
    UI.init();
    Store.on('replaced', () => { MapView.refreshAll(); UI.renderGhStatus(); });
    Store.on('owners', (fids) => { MapView.restyleProvinces(fids); Silhouettes.schedule(); });
    Store.on('countries', () => {
      MapView.restyleProvinces(null); MapView.renderCustom(); MapView.renderCapitals();
      Silhouettes.refreshVisuals(); Silhouettes.schedule(); MapView.renderLabels();
    });
    Store.on('custom', () => { MapView.renderCustom(); Silhouettes.schedule(); Tools.onCustomChanged(); });
    Store.on('names', () => { if (MapView.hoverLayer) MapView.restyle(MapView.hoverLayer); UI.scheduleRefresh(); });
    this.bindGlobalEvents();
    this.setMod(kv.get(SS, CONFIG.keys.mod) === true, { quiet: true });

    setLoader('Загрузка сетки провинций и состояния карты…');
    const [geo, st] = await Promise.allSettled([Geo.loadDefault(), this.fetchState()]);

    if (st.status === 'fulfilled') Store.replace(st.value.data, { sha: st.value.sha });
    else { toast(`Не удалось загрузить состояние карты: ${st.reason.message}`, 'error', 8000); Store.replace(emptyState()); }

    if (geo.status === 'fulfilled') {
      setLoader('Отрисовка провинций…', { progress: 'indeterminate', sub: `${Geo.features.length} областей` });
      await nextFrame();
      MapView.renderProvinces();
      MapView.refreshAll();
      UI.refreshAll();
    } else {
      toast(`Не удалось загрузить сетку провинций: ${geo.reason.message}`, 'error', 10000);
    }

    setLoader(false);
    this.checkDraft();
    this.applyHash();
  },

  /** Модератор с токеном читает файл через API (без задержки деплоя Pages), остальные — с самого сайта. */
  async fetchState() {
    if (GitHub.ready()) {
      try {
        const f = await GitHub.getFile();
        if (f) return { data: JSON.parse(f.text), sha: f.sha };
      } catch (e) { console.warn('[App] чтение через GitHub API не удалось, читаю с сайта', e); }
    }
    const r = await fetch(`${CONFIG.stateFile}?t=${Date.now()}`, { cache: 'no-store' });
    if (r.status === 404) return { data: emptyState(), sha: null };
    if (!r.ok) throw new Error(`${r.status} — ${CONFIG.stateFile}`);
    const text = await r.text();
    return { data: JSON.parse(text), sha: await gitBlobSha(text).catch(() => null) };
  },

  bindGlobalEvents() {
    const trackKeys = (e) => { Keys.alt = e.altKey; Keys.shift = e.shiftKey; };
    document.addEventListener('keydown', trackKeys, true);
    document.addEventListener('keyup', trackKeys, true);
    window.addEventListener('blur', () => { Keys.alt = Keys.shift = false; Tools.endStroke(); });
    window.addEventListener('hashchange', () => this.applyHash());
    window.addEventListener('beforeunload', (e) => {
      if (this.modMode && Store.dirty) { Drafts.save(); e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      const typing = t.closest('textarea, select, [contenteditable]') ||
        (t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color|file)$/i.test(t.type));
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyS') { if (this.modMode) { e.preventDefault(); this.saveToGitHub(); } return; }
      if (typing) { if (e.key === 'Escape') t.blur(); return; }
      if (Ruler.active) {
        if (e.key === 'Escape') { e.preventDefault(); Ruler.points.length ? Ruler.clear() : Ruler.toggle(false); return; }
        if (e.key === 'Enter') { e.preventDefault(); Ruler.finish(); return; }
        if (e.key === 'Backspace') { e.preventDefault(); Ruler.undoPoint(); return; }
      }
      if (e.code === 'KeyR' && !mod && !e.altKey) { Ruler.toggle(); return; }
      if (e.code === 'KeyA' && !mod && !e.altKey) { UI.togglePref('labels'); return; }
      if (e.key === 'Escape') {
        if (Tools.tool === 'draw' && Tools.draw.points.length) Tools.cancelDraw();
        else if (Tools.editing) Tools.stopEdit();
        else if (Tools.tool === 'capital') Tools.finishPointPick(null);
        else UI.closeInfo();
        return;
      }
      if (!this.modMode) return;
      // Alt в браузере фокусирует меню — во время рисования он нужен для отключения привязки
      if (e.key === 'Alt' && (Tools.tool === 'draw' || Tools.editing)) { e.preventDefault(); return; }
      if (mod && e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); Store.undo(); return; }
      if (mod && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) { e.preventDefault(); Store.redo(); return; }
      if (mod || e.altKey) return;
      if (Tools.tool === 'draw') {
        if (e.key === 'Enter') { e.preventDefault(); Tools.finishDraw(); return; }
        if (e.key === 'Backspace') { e.preventDefault(); Tools.popVertex(); return; }
      }
      // e.code — чтобы горячие клавиши работали и в кириллической раскладке
      if (e.code === 'KeyM') { Tools.toggleSnap(); return; }
      const map = { KeyV: 'select', KeyB: 'paint', KeyE: 'erase', KeyI: 'pick', KeyP: 'draw', KeyN: 'rename' };
      if (map[e.code]) Tools.set(map[e.code]);
    });
  },

  /* — режим модератора — */
  toggleMod() {
    if (this.modMode && Store.dirty &&
        !confirm('Есть несохранённые изменения. Выйти из режима модератора?\n(Черновик останется в этом браузере.)')) return;
    this.setMod(!this.modMode);
  },
  setMod(on, { quiet = false } = {}) {
    if (!on) Drafts.save();
    this.modMode = on;
    kv.set(SS, CONFIG.keys.mod, on);
    document.body.classList.toggle('mod-mode', on);
    const btn = $('#btn-mod');
    btn.querySelector('i').className = on ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock';
    btn.querySelector('.label').textContent = on ? 'Выйти' : 'Модератор';
    btn.classList.toggle('active', on);
    $('#btn-save').hidden = !on;
    $('#toolbar').hidden = !on;
    if (!on) { Tools.stopEdit(); Tools.set('select'); UI.showTab('countries'); }
    else if (!quiet && !GitHub.ready()) { UI.openSidebar(); UI.showTab('github'); toast('Для сохранения в репозиторий укажите токен GitHub', 'info', 5000); }
    if (MapView.map) { Tools.sync(); MapView.restyleCustoms(); }
    UI.refreshInfo();
    UI.renderCountryList();
  },

  /* — сохранение / загрузка — */
  async saveToGitHub() {
    if (!this.modMode || this._saving) return;
    if (!GitHub.ready()) {
      toast('Укажите репозиторий и токен во вкладке GitHub', 'warn');
      UI.openSidebar(); UI.showTab('github');
      return;
    }
    this._saving = true;
    UI.setSaving(true);
    try {
      const remote = await GitHub.getFile();
      if (remote && remote.sha !== Store.sha) {
        const ok = confirm(Store.sha
          ? 'Файл в репозитории изменился после того, как вы его загрузили (возможно, его сохранил другой модератор).\n\nОК — перезаписать своей версией.\nОтмена — ничего не сохранять (затем можно загрузить свежую версию во вкладке GitHub).'
          : 'Версия файла в репозитории неизвестна этой вкладке. Перезаписать её текущим состоянием карты?');
        if (!ok) return;
      }
      const rev = Store.rev;
      const msg = $('#commit-msg').value.trim() || `Обновление карты · ${new Date().toLocaleString('ru-RU')}`;
      Store.sha = await GitHub.putFile(Store.serialize(), msg, remote?.sha);
      if (Store.rev === rev) { Store.setDirty(false); Drafts.clear(); }
      $('#commit-msg').value = '';
      UI.renderGhStatus();
      toast('Сохранено в GitHub. Сайт на Pages обновится через 1–2 минуты.', 'ok', 6000);
    } catch (e) {
      console.error(e);
      toast(`Ошибка сохранения: ${e.message}`, 'error', 9000);
    } finally {
      this._saving = false;
      UI.setSaving(false);
    }
  },

  async reloadFromGitHub() {
    if (!GitHub.ready()) { toast('Укажите репозиторий и токен', 'warn'); return; }
    if (Store.dirty && !confirm('Несохранённые изменения будут потеряны. Загрузить версию из репозитория?')) return;
    try {
      setLoader('Загрузка из репозитория…', { progress: 'indeterminate' });
      const f = await GitHub.getFile();
      if (!f) { toast('Файла в репозитории пока нет — он будет создан при первом сохранении', 'info', 6000); return; }
      Store.replace(JSON.parse(f.text), { sha: f.sha });
      Drafts.clear();
      toast('Загружена свежая версия из репозитория', 'ok');
    } catch (e) {
      toast(`Ошибка загрузки: ${e.message}`, 'error', 8000);
    } finally { setLoader(false); }
  },

  async loadGridFile(file) {
    try {
      setLoader(`Чтение ${file.name}…`, { progress: 'indeterminate', sub: fmtMB(file.size) });
      await nextFrame();
      const data = JSON.parse(await file.text());
      setLoader(`Очистка геометрии ${file.name}…`, { progress: 'indeterminate' });
      await nextFrame();
      await Geo.ingest(data, `файл ${file.name}`);
      setLoader('Отрисовка провинций…', { progress: 'indeterminate' });
      await nextFrame();
      MapView.renderProvinces();
      MapView.refreshAll();
      UI.refreshAll();
      const owners = Object.keys(Store.state.provinceOwners);
      const matched = owners.filter((fid) => Geo.byId.has(fid)).length;
      toast(`Сетка загружена: ${MapView.layerById.size} полигонов. Совпало владений: ${matched} из ${owners.length}.`, 'ok', 7000);
      if (MapView.layerById.size) MapView.map.fitBounds(MapView.provinceGroup.getBounds(), { padding: [20, 20] });
    } catch (e) {
      console.error(e);
      toast(`Не удалось загрузить сетку: ${e.message}`, 'error', 9000);
    } finally { setLoader(false); }
  },

  checkDraft() {
    const d = Drafts.get();
    if (!d?.state) return;
    if (JSON.stringify(normalizeState(d.state)) === JSON.stringify(Store.state)) { Drafts.clear(); return; }
    UI.showDraftBanner(d,
      () => { if (!this.modMode) this.setMod(true, { quiet: true }); Store.replace(d.state, { sha: Store.sha, dirty: true }); toast('Черновик восстановлен', 'ok'); },
      () => { Drafts.clear(); toast('Черновик удалён', 'info'); });
  },

  /* — ссылки вида #c=country_1 / #p=804 — */
  setHash(v) {
    const url = location.pathname + location.search + (v ? `#${encodeURIComponent(v).replace('%3D', '=')}` : '');
    history.replaceState(null, '', url);
  },
  applyHash() {
    const m = decodeURIComponent(location.hash.slice(1)).match(/^([cp])=(.+)$/);
    if (!m) return;
    if (m[1] === 'c' && Store.country(m[2])) UI.openCountry(m[2], { fly: true });
    if (m[1] === 'p' && Geo.byId.has(m[2])) { MapView.flyToProvince(m[2]); UI.openProvince(m[2]); }
  },
};

// Отладка из консоли: window.RPMap.Store.state и т.п.
window.RPMap = { CONFIG, Store, Geo, Silhouettes, Ruler, MapView, Tools, GitHub, UI, App };
App.init().catch((e) => { console.error(e); setLoader(`Ошибка инициализации: ${e.message}`); });

})();
