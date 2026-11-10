// Dev-only stand-in for chrome.* so the real side panel runs in a normal tab:
//   /ext/sidepanel/sidepanel.html?harness=1&order=1166310            (as if on an EZ order page)
//   /ext/sidepanel/sidepanel.html?harness=1&page=none                (demo mode: not on EZ)
//   add &present=1 to pretend every field is on the page (exercises Apply / Undo)
//   add &signedout=1 to start signed out: the sign-in form then signs in against this backend for real
// Plays the service worker against this backend using saved fixtures instead of scraping EZ.
(function () {
  const q = new URLSearchParams(location.search);
  const ORDER = Number(q.get('order') || 1166310);
  const NOT_EZ = q.get('page') === 'none', PRESENT = q.get('present') === '1', SIGNED_OUT = q.get('signedout') === '1';
  const loadAuth = () => { try { return JSON.parse(localStorage.getItem('h_auth')); } catch { return null; } };
  let auth = SIGNED_OUT ? loadAuth() : null;
  const listeners = [], session = {}, updated = [];
  // simulate the EZ tab moving to another page: __harnessNavigate({ page: 'images', orderId: 1166305 })
  window.__harnessNavigate = det => { window.__harnessDet = det; updated.forEach(f => f(1, { status: 'complete' })); };
  const emit = m => listeners.forEach(f => f(m, {}));
  let config = { apiBase: location.origin, token: SIGNED_OUT ? '' : 'dev-token' };
  const bearer = () => auth?.accessToken || config.token;
  const api = async (method, path, body) => {
    const r = await fetch(config.apiBase + path, { method, headers: { Authorization: 'Bearer ' + bearer(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (r.status === 401 && auth) {   // like the worker: the sign-in ended (e.g. signed out from the dashboard) → sign-in card with the reason
      auth = null; localStorage.removeItem('h_auth'); emit({ type: 'AUTH_CHANGED', signedIn: false, message: j.error?.message });
      throw Object.assign(new Error(j.error?.message || 'Please sign in.'), { signIn: true });
    }
    if (!r.ok) throw new Error(j.error?.message || r.status); return { status: r.status, json: j };
  };
  // Same split as the worker: PREPARE (order opened) reads + uploads, ANALYZE (Run) reuses it and starts the AI.
  // &prepdelay=ms slows the fake read down so the "Getting the order ready" hint can be seen.
  const PREP_DELAY = Number(q.get('prepdelay') || 1500), preps = new Map();
  const prepare = (orderId, force) => {
    if (preps.has(orderId) && !force) return preps.get(orderId);
    const pr = (async () => {
      const p = (stage, message, extra = {}) => emit({ type: 'PROGRESS', orderId, stage, message, ...extra });
      const t0 = Date.now();
      p('scrape', 'Reading the order (harness: saved fixture)…');
      const existing = await api('GET', `/v1/orders/${orderId}/snapshot`).catch(() => null);
      const snap = existing?.json?.snapshot || await (await fetch(`/fixtures/boost-${orderId}.json`)).json();
      p('scrape', `Read 1 of ${snap.forms.length + 1} pages: ${snap.forms[0]?.name || 'order'}`); await new Promise(r => setTimeout(r, PREP_DELAY / 2));
      p('scrape', `Read ${snap.forms.length + 1} of ${snap.forms.length + 1} pages: Images page`); await new Promise(r => setTimeout(r, PREP_DELAY / 2));
      p('scrape', `Read ${snap.forms.length} forms, ${snap.photos.length} photos`, { done: true });
      const put = existing ? { photosNeeded: [] } : (await api('PUT', `/v1/orders/${orderId}/snapshot`, snap)).json;
      p('upload', 'Snapshot uploaded', { done: true });
      p('photos', `Harness: ${put.photosNeeded.length} photos not uploaded`, { done: true, progress: 1 });
      const fields = snap.forms.reduce((a, f) => a + f.sections.reduce((b, s) => b + s.fields.length, 0), 0);
      return { orderId, forms: snap.forms.length, fields, photos: snap.photos.length, sent: 0, failed: 0, unchanged: !!existing, secs: Math.round((Date.now() - t0) / 1000), at: Date.now() };
    })();
    preps.set(orderId, pr); pr.catch(() => preps.delete(orderId));
    return pr;
  };
  const analyze = async (orderId, force) => {
    const p = (stage, message, extra = {}) => emit({ type: 'PROGRESS', orderId, stage, message, ...extra });
    const prep = await prepare(orderId, force);
    p('scrape', `Read ${prep.forms} forms, ${prep.fields} fields, ${prep.photos} photos`, { done: true });
    p('upload', 'Ready', { done: true }); p('photos', 'Photos ready', { done: true, progress: 1 });
    const { json } = await api('POST', `/v1/orders/${orderId}/analyses${force ? '?force=true' : ''}`, {});
    return { orderId, analysisId: json.analysisId, cached: !!json.cached };
  };
  window.__harnessLog = [];   // every message the panel sends, for checks from the console
  // this "computer" (the extension keeps it in chrome.storage.local.device)
  const device = () => { let d; try { d = JSON.parse(localStorage.getItem('h_device')); } catch {} if (!d?.id) { d = { id: crypto.randomUUID(), name: '' }; localStorage.setItem('h_device', JSON.stringify(d)); } return d; };
  const handlers = {
    GET_CONFIG: async () => ({ ...config, bearer: bearer() }),
    AUTH_STATE: async () => { const computer = device().name; return auth ? { signedIn: true, user: auth.user, org: auth.org, computer } : config.token ? { signedIn: true, dev: true, user: { name: 'Developer', role: 'admin' } } : { signedIn: false, computer }; },
    LOGIN: async m => { const d = device(); if (m.deviceName !== undefined) { d.name = String(m.deviceName).trim().slice(0, 40); localStorage.setItem('h_device', JSON.stringify(d)); }
      const r = await fetch('/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: m.email, password: m.password, client: 'extension', deviceId: d.id, deviceName: d.name }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.status); auth = j; localStorage.setItem('h_auth', JSON.stringify(j)); return { signedIn: true, user: j.user, org: j.org }; },
    LOGOUT: async () => { if (auth) await fetch('/v1/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: auth.refreshToken }) }); auth = null; localStorage.removeItem('h_auth'); return { signedIn: false }; },
    HEALTH: async () => { if (!(await fetch('/v1/health')).ok) throw new Error('offline'); return { ok: true }; },
    DETECT: async () => window.__harnessDet || (NOT_EZ ? { page: 'none' } : { page: 'form', orderId: ORDER, host: 'server-ezsm.ezsurveyform.com' }),
    LATEST: async m => (await api('GET', `/v1/orders/${m.orderId}/analyses/latest`).catch(() => ({ json: null }))).json,
    API: async m => (await api(m.method, m.path, m.body)).json,
    FEEDBACK: async m => (await api('POST', '/v1/feedback', m.body)).json,
    ANALYZE: async m => analyze(m.orderId, m.force),
    PREPARE: async m => prepare(m.orderId, m.force),
    // simulated pages: captions only on the Images page, nothing on report/list pages, form fields elsewhere
    PRESENT: async m => { const p = window.__harnessDet?.page; return Object.fromEntries(m.keys.map(k => [k, PRESENT && (p === 'images' ? /^caption/.test(k) : !p || p === 'form' ? !/^caption/.test(k) : false)])); },
    APPLY: async m => ({ ok: PRESENT, results: m.writes.map(w => ({ key: w.key, resolved: w.key.replace(':new', '_1056_1_10321510'), ok: PRESENT, prev: '', kind: w.kind, reason: PRESENT ? '' : 'harness: no EZ page' })) }),
    REVERT: async m => ({ ok: true, reverted: m.keys.map(k => (typeof k === 'string' ? k : k.key)) }),
    FOCUS_PHOTO: async m => (PRESENT && window.__harnessDet?.page === 'images' ? { ok: true } : { ok: false, reason: 'harness: not on the Images page' }),
    FOCUS: async m => (PRESENT ? { ok: true } : { ok: false, reason: 'harness: no EZ page (' + m.key + ')' }),
    HIGHLIGHT: async m => ({ onPage: PRESENT ? m.items.length : 0 }),
    CLEAR_HIGHLIGHT: async () => ({ ok: true }),
    SHOW_PHOTOS: async () => { throw new Error('harness: no EZ page'); },
  };
  window.chrome = {
    runtime: { lastError: null, onMessage: { addListener: f => listeners.push(f) },
      getManifest: () => ({ version: '0.4.0' }), getURL: p => location.origin + '/ext/' + p,
      sendMessage(msg, cb) { window.__harnessLog.push(msg); const h = handlers[msg.type]; (h ? h(msg) : Promise.reject(new Error('harness: unhandled ' + msg.type))).then(d => cb?.({ ok: true, data: d }), e => cb?.({ ok: false, error: e.message })); } },
    tabs: { query: async () => [{ id: 1, url: NOT_EZ ? 'chrome://newtab/' : 'https://server-ezsm.ezsurveyform.com/cgi-bin/current/aa.cgi?g=3&orderid=' + ORDER }],
      update: async (id, o) => console.log('[harness] tabs.update', o.url),
      get: async id => ({ id, index: 0 }), create: async o => { window.__harnessCreated = o.url; return { id: 2 }; }, onActivated: { addListener() {} }, onUpdated: { addListener: f => updated.push(f) } },
    // the viewer window opens as a normal tab in the harness (with harness=1 so it gets this stub too)
    windows: { create: async o => { window.__harnessViewer = o; window.open(o.url.replace('?', '?harness=1&'), '_blank'); return { id: 3 }; }, update: async () => ({}) },
    storage: { session: { get: async k => ({ [k]: session[k] }), set: async o => Object.assign(session, o) },
      local: { get: async k => { try { return { [k]: JSON.parse(localStorage.getItem('h_' + k)) }; } catch { return {}; } }, set: async o => { for (const [k, v] of Object.entries(o)) try { localStorage.setItem('h_' + k, JSON.stringify(v)); } catch {} } } },
  };
})();
