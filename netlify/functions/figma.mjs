// AdAutonomy board reader.  Reads a Figma board through Figma's REST API, which only needs VIEW access to the file.
//
// Two ways in, tried in this order:
//   1. The person's own Figma login. GET /api/figma/auth sends them to Figma's "Allow AdAutonomy to view your files"
//      page (OAuth); /api/figma/callback stores the grant in an encrypted, httpOnly cookie for that browser.
//      Needs FIGMA_CLIENT_ID + FIGMA_CLIENT_SECRET on the site (a free app registration at figma.com/developers/apps,
//      callback URL https://<site>/api/figma/callback). The person never sees a token.
//   2. FIGMA_TOKEN on the site: a personal access token (File content read) from any account that can view the boards.
//
// POST /api/figma { url, action:'list' }                    -> { fileKey, name, lastModified, scoped, pages:[{ id, name, frames:[{ id, name, w, h, section }] }] }
// POST /api/figma { url, action:'render', ids:[...], scale } -> { images: { id: url|null } }   (Figma renders the frames; URLs live about 30 days)
// GET  /api/figma                                            -> { ok, figma, connected, oauth, account }
// GET  /api/figma?img=<figma image url>                      -> the image bytes, same origin
// GET  /api/figma/auth?return=<same-origin url>              -> redirect to Figma
// GET  /api/figma/callback?code&state                        -> stores the grant, redirects back
// GET  /api/figma/disconnect?return=<same-origin url>        -> forgets the grant in this browser
import { env, json, fail, err, checkAccess } from './lib/google.mjs';

const API = 'https://api.figma.com/v1';
const OAUTH_AUTHORIZE = 'https://www.figma.com/oauth';
const OAUTH_TOKEN = 'https://api.figma.com/v1/oauth/token';
const OAUTH_REFRESH = 'https://api.figma.com/v1/oauth/refresh';
const SCOPES = 'file_content:read,current_user:read';
const COOKIE = 'ada_fig', STATE_COOKIE = 'ada_fig_state';
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

export default async (req) => {
  const u = new URL(req.url);
  const route = u.pathname.replace(/\/+$/, '');
  if (route.endsWith('/auth')) return startAuth(req, u);
  if (route.endsWith('/callback')) return finishAuth(req, u);
  if (route.endsWith('/disconnect')) return redirect(safeReturn(u, u.searchParams.get('return')), { 'set-cookie': clearCookie(COOKIE) });

  if (req.method === 'GET') {
    const img = u.searchParams.get('img');
    if (!img) {
      const grant = await readGrant(req);
      return json({ ok: true, figma: !!(grant || env('FIGMA_TOKEN')), connected: !!grant, oauth: !!env('FIGMA_CLIENT_ID'), account: grant?.email || null });
    }
    if (!checkAccess(req)) return new Response('Unauthorized', { status: 401 });
    let target; try { target = new URL(img); } catch { return fail('bad_request', 'Not an image address.'); }
    if (!/(^|\.)amazonaws\.com$|(^|\.)figma\.com$/.test(target.hostname)) return fail('bad_request', 'Only images rendered by Figma can be fetched here.');
    const r = await fetch(target);
    if (!r.ok) return fail('render_fetch', `Figma's image store answered ${r.status}.`, 502);
    return new Response(r.body, { status: 200, headers: { 'content-type': r.headers.get('content-type') || 'image/png', 'cache-control': 'private, max-age=3600' } });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!checkAccess(req)) return new Response('Unauthorized', { status: 401 });
  let body; try { body = await req.json(); } catch { return fail('bad_request', 'Send JSON with a url.'); }
  const url = String(body.url || '').trim();
  const m = url.match(/figma\.com\/(?:design|file|board|proto|slides)\/([A-Za-z0-9]+)/);
  if (!m) return fail('unknown_link', 'That is not a Figma file link.');
  const fileKey = m[1];
  const nodeId = (url.match(/[?&]node-id=([^&#]+)/) || [])[1]?.replace(/-/g, ':') || null;

  // Whose access to use.
  let auth = null; let setCookie = null;
  const grant = await readGrant(req);
  if (grant) {
    if (grant.exp - Date.now() < 36 * 3600 * 1000 && grant.rt) {
      try { const fresh = await refreshGrant(grant); auth = { token: fresh.at, oauth: true, email: fresh.email }; setCookie = await writeCookie(fresh); }
      catch { setCookie = clearCookie(COOKIE); return withCookie(fail('figma_connect_required', 'Your Figma connection has expired. Connect Figma again (one click).', 401), setCookie); }
    } else auth = { token: grant.at, oauth: true, email: grant.email };
  } else if (env('FIGMA_CLIENT_ID', '')) return fail('figma_connect_required', 'Connect your Figma account to read boards from a link. One click; view access is all it uses.', 401);
  else if (env('FIGMA_TOKEN', '')) auth = { token: env('FIGMA_TOKEN'), oauth: false };
  else if (req.headers.get('x-figma-token')) auth = { token: req.headers.get('x-figma-token'), oauth: false };
  if (!auth) return fail('figma_token_required', 'Board reading is not connected on this workspace yet.', 401);
  try {
    const out = body.action === 'render' ? await render(fileKey, body.ids || [], body.scale, body.format, auth) : await list(fileKey, nodeId, auth);
    return withCookie(json(out), setCookie);
  } catch (e) {
    if (e.code === 'figma_unauthorized' && auth.oauth) return withCookie(fail('figma_connect_required', 'Figma no longer accepts this connection. Connect Figma again (one click).', 401), clearCookie(COOKIE));
    return withCookie(fail(e.code || 'figma_failed', e.message || String(e), e.status || 502), setCookie);
  }
};

/* ---------- OAuth: sending the person to Figma and back ---------- */
function siteOrigin(u) { return env('URL', '') || `${u.protocol}//${u.host}`; }
function safeReturn(u, ret) { const origin = siteOrigin(u); try { const r = new URL(ret || '/', origin); if (r.origin === new URL(origin).origin) return r.toString(); } catch {} return origin + '/'; }
function redirect(location, headers = {}) { return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...headers } }); }
function rand(n = 24) { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); }

async function startAuth(req, u) {
  const id = env('FIGMA_CLIENT_ID', ''); if (!id) return fail('not_configured', 'Figma sign-in is not set up on this site yet.', 503);
  const state = rand() + '.' + Buffer.from(safeReturn(u, u.searchParams.get('return'))).toString('base64url');
  const q = new URLSearchParams({ client_id: id, redirect_uri: `${siteOrigin(u)}/api/figma/callback`, scope: SCOPES, state, response_type: 'code' });
  return redirect(`${OAUTH_AUTHORIZE}?${q}`, { 'set-cookie': cookie(STATE_COOKIE, state, 600) });
}

async function finishAuth(req, u) {
  const state = u.searchParams.get('state') || '', code = u.searchParams.get('code') || '';
  const expected = readCookie(req, STATE_COOKIE);
  const back = (() => { try { return Buffer.from(state.split('.')[1] || '', 'base64url').toString() || siteOrigin(u) + '/'; } catch { return siteOrigin(u) + '/'; } })();
  const fail2 = (why) => { const r = new URL(safeReturn(u, back)); r.searchParams.set('figma_error', why); return redirect(r.toString(), { 'set-cookie': clearCookie(STATE_COOKIE) }); };
  if (!code || !state || state !== expected) return redirect(safeReturn(u, back), { 'set-cookie': clearCookie(STATE_COOKIE) });
  const id = env('FIGMA_CLIENT_ID', ''), secret = env('FIGMA_CLIENT_SECRET', '');
  const basic = 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch(OAUTH_TOKEN, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ redirect_uri: `${siteOrigin(u)}/api/figma/callback`, code, grant_type: 'authorization_code' }) });
  if (!r.ok) return fail2(`Figma did not complete the sign-in (${r.status}).`);
  const t = await r.json();
  if (!t.access_token) return fail2('Figma sent no access.');
  let email = ''; try { const me = await fetch(API + '/me', { headers: { authorization: `Bearer ${t.access_token}` } }); if (me.ok) email = (await me.json()).email || ''; } catch {}
  const grant = { at: t.access_token, rt: t.refresh_token || null, exp: Date.now() + (Number(t.expires_in) || 7776000) * 1000, email };
  const headers = new Headers({ location: safeReturn(u, back), 'cache-control': 'no-store' });
  headers.append('set-cookie', await writeCookie(grant)); headers.append('set-cookie', clearCookie(STATE_COOKIE));
  return new Response(null, { status: 302, headers });
}

async function refreshGrant(grant) {
  const id = env('FIGMA_CLIENT_ID', ''), secret = env('FIGMA_CLIENT_SECRET', '');
  const basic = 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch(OAUTH_REFRESH, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ refresh_token: grant.rt }) });
  if (!r.ok) throw new Error('refresh failed');
  const t = await r.json(); if (!t.access_token) throw new Error('refresh failed');
  return { ...grant, at: t.access_token, exp: Date.now() + (Number(t.expires_in) || 7776000) * 1000 };
}

/* ---------- The grant cookie: encrypted so the token never sits in the clear ---------- */
function cookie(name, value, maxAge) { return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`; }
function clearCookie(name) { return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`; }
function readCookie(req, name) { const c = req.headers.get('cookie') || ''; const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; }
function withCookie(res, sc) { if (!sc) return res; const h = new Headers(res.headers); h.append('set-cookie', sc); return new Response(res.body, { status: res.status, headers: h }); }
async function cryptoKey() {
  const secret = env('FIGMA_CLIENT_SECRET', '') || env('REVIEWER_ACCESS_CODE', '') || 'adautonomy';
  const raw = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode('ada-figma:' + secret));
  return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function writeCookie(grant) {
  const key = await cryptoKey(); const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(grant))));
  const packed = Buffer.from(iv).toString('base64url') + '.' + Buffer.from(ct).toString('base64url');
  return cookie(COOKIE, packed, 180 * 24 * 3600);
}
async function readGrant(req) {
  const v = readCookie(req, COOKIE); if (!v) return null;
  try {
    const [ivb, ctb] = v.split('.'); const key = await cryptoKey();
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(ivb, 'base64url') }, key, Buffer.from(ctb, 'base64url'));
    const g = JSON.parse(new TextDecoder().decode(pt)); return g && g.at ? g : null;
  } catch { return null; }
}

/* ---------- Figma REST ---------- */
const authHeaders = (auth) => auth.oauth ? { authorization: `Bearer ${auth.token}` } : { 'X-Figma-Token': auth.token };

// Whose access this is, for the sharing instructions. Best effort, cached per instance.
let whoami = null;
async function accountEmail(auth) {
  if (auth.email) return auth.email;
  if (whoami !== null) return whoami;
  try { const r = await fetch(API + '/me', { headers: authHeaders(auth) }); whoami = r.ok ? ((await r.json()).email || '') : ''; } catch { whoami = ''; }
  return whoami;
}

async function figma(path, auth) {
  const r = await fetch(API + path, { headers: authHeaders(auth) });
  if (r.status === 403 || r.status === 401 || r.status === 404) {
    let detail = ''; try { const t = await r.text(); detail = (JSON.parse(t).message || JSON.parse(t).err || '').toString(); } catch { detail = ''; }
    if (r.status === 401 && auth.oauth) throw err('figma_unauthorized', 'Figma no longer accepts this connection.', 401);
    const who = await accountEmail(auth);
    const whoTxt = auth.oauth ? (who ? `the Figma account you connected (${who})` : 'the Figma account you connected') : (who ? `the workspace's Figma account (${who})` : "the workspace's Figma account");
    if (r.status === 404 && !who) throw err('figma_not_found', 'Figma could not find that file. Check the link.', 404);
    if (/scope/i.test(detail)) throw err('figma_scope', auth.oauth ? `Figma did not grant file access on this connection (Figma said: ${detail}). Disconnect and connect Figma again, and click Allow on Figma's page.` : `The site's Figma key cannot read file contents (Figma said: ${detail}). Generate a new personal access token with "File content" set to read, and replace FIGMA_TOKEN.`, 403);
    if (/plan|enterprise|organization|admin|REST API|disabled/i.test(detail)) throw err('figma_denied', `Figma refused access to this file (Figma said: ${detail}). The owner's Figma organization may block API access; a Figma admin at the organization can allow it. Or drop the exported frames instead.`, 403);
    throw err('figma_denied', `This board is not open to ${whoTxt}${detail ? ` (Figma said: ${detail})` : ''}. ${auth.oauth ? 'Open the board in Figma to confirm you can see it, or ask the owner to share it with you' : 'Ask whoever owns the board to share it with that address (view is enough), or to set the file\'s sharing to "Anyone with the link can view"'}, then paste the link again. Or drop the exported frames instead.`, 403);
  }
  if (r.status === 429) throw err('figma_rate_limit', 'Figma is rate-limiting this connection for a moment. Wait a minute and try again.', 429);
  if (!r.ok) throw err('figma_error', `Figma answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const box = n => n.absoluteBoundingBox || n.absoluteRenderBounds || {};
const frameOf = (n, section) => ({ id: n.id, name: n.name, type: n.type, w: Math.round(box(n).width || 0), h: Math.round(box(n).height || 0), section: section || null });

// Deliverable frames are the ones with a UAID in the name. Studios nest them: page -> "Advertising" -> "Layout design" -> frames,
// so this walks down through frames, sections and groups that have no UAID of their own, a few levels deep, fetching the
// children Figma left out. The first container's name is kept as the frame's section (usually the platform).
const UAID_RE = /\d{5}-\d{6}/;
const SKIP_RE = /^(main components?|components?|status|title|legend|notes?|cover|thumbnail)$/i;
const CONTAINER = n => FRAME_TYPES.has(n.type) || n.type === 'SECTION' || n.type === 'GROUP';
async function collect(fileKey, nodes, auth) {
  const frames = [];
  let pending = nodes.filter(CONTAINER).map(n => ({ n, section: null, top: true }));
  for (let level = 0; level < 5 && pending.length; level++) {
    const next = []; const toFetch = [];
    for (const item of pending) {
      const { n, section, top } = item;
      if (FRAME_TYPES.has(n.type) && UAID_RE.test(n.name)) { frames.push(frameOf(n, section)); continue; }
      if (SKIP_RE.test((n.name || '').trim())) continue;
      if (n.children) item.children = n.children; else toFetch.push(item);
    }
    for (let i = 0; i < toFetch.length; i += 40) {
      const batch = toFetch.slice(i, i + 40);
      const r = await figma(`/files/${fileKey}/nodes?ids=${encodeURIComponent(batch.map(b => b.n.id).join(','))}&depth=1`, auth);
      for (const b of batch) b.children = r.nodes?.[b.n.id]?.document?.children || [];
    }
    for (const item of pending) {
      if (!item.children) continue;
      const kids = item.children.filter(CONTAINER);
      const sec = item.section || (item.top ? item.n.name : null);
      if (kids.length) next.push(...kids.map(k => ({ n: k, section: sec, top: false })));
      else if (FRAME_TYPES.has(item.n.type) && !item.top) frames.push(frameOf(item.n, item.section)); // a leaf without a UAID: mockup or reference
    }
    pending = next;
  }
  return frames;
}

async function list(fileKey, nodeId, auth) {
  if (nodeId) {
    const r = await figma(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=2`, auth);
    const doc = r.nodes?.[nodeId]?.document;
    if (!doc) throw err('figma_not_found', 'That node is not in the file any more.', 404);
    let frames;
    if (doc.type === 'CANVAS' || doc.type === 'SECTION' || doc.type === 'GROUP') frames = await collect(fileKey, doc.children || [], auth);
    else if (FRAME_TYPES.has(doc.type)) { frames = UAID_RE.test(doc.name) ? [frameOf(doc)] : await collect(fileKey, [doc], auth); if (!frames.length) frames = [frameOf(doc)]; }
    else frames = [];
    return { fileKey, name: r.name || '', lastModified: r.lastModified || null, scoped: doc.name, pages: [{ id: doc.id, name: doc.type === 'CANVAS' ? doc.name : `${doc.name} (${doc.type.toLowerCase()})`, frames }] };
  }
  const f = await figma(`/files/${fileKey}?depth=2`, auth);
  const pages = [];
  for (const page of f.document?.children || []) {
    if (page.type !== 'CANVAS') continue;
    pages.push({ id: page.id, name: page.name, frames: await collect(fileKey, page.children || [], auth) });
  }
  return { fileKey, name: f.name || '', lastModified: f.lastModified || null, scoped: null, pages };
}

async function render(fileKey, ids, scale, format, auth) {
  ids = ids.map(String).filter(Boolean).slice(0, 25);
  if (!ids.length) throw err('bad_request', 'No frames to render.', 400);
  const sc = Math.min(4, Math.max(0.1, Number(scale) || 1)); const fmt = ['png', 'jpg', 'svg', 'pdf'].includes(format) ? format : 'png';
  const r = await figma(`/images/${fileKey}?ids=${encodeURIComponent(ids.join(','))}&format=${fmt}&scale=${sc}&use_absolute_bounds=false`, auth);
  if (r.err) throw err('figma_render', `Figma could not render: ${r.err}`);
  return { images: r.images || {} };
}

export const config = { path: ['/api/figma', '/api/figma/auth', '/api/figma/callback', '/api/figma/disconnect'] };
