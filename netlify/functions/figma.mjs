// AdAutonomy board reader.  Reads a Figma board through Figma's REST API, which only needs VIEW access to the file.
// POST /api/figma { url, action:'list' }                    -> { fileKey, name, lastModified, scoped, pages:[{ id, name, frames:[{ id, name, w, h, section }] }] }
// POST /api/figma { url, action:'render', ids:[...], scale } -> { images: { id: url|null } }   (Figma renders the frames; URLs live about 30 days)
// GET  /api/figma?img=<figma image url>                      -> the image bytes, same origin (for browsers that cannot fetch Figma's store directly)
// Token: FIGMA_TOKEN on the site (a personal access token from any Figma account, File content read). Boards must be visible to that account.
import { env, json, fail, err, checkAccess } from './lib/google.mjs';

const API = 'https://api.figma.com/v1';
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

export default async (req) => {
  const u = new URL(req.url);
  if (req.method === 'GET') {
    const img = u.searchParams.get('img');
    if (!img) return json({ ok: true, figma: !!env('FIGMA_TOKEN') });
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
  const token = env('FIGMA_TOKEN', '') || req.headers.get('x-figma-token');
  if (!token) return fail('figma_token_required', 'Board reading is not connected on this workspace yet. Add FIGMA_TOKEN to the site.', 401);
  try {
    if (body.action === 'render') return json(await render(fileKey, body.ids || [], body.scale, body.format, token));
    return json(await list(fileKey, nodeId, token));
  } catch (e) { return fail(e.code || 'figma_failed', e.message || String(e), e.status || 502); }
};

// Who the workspace's Figma connection is, for the sharing instructions. Best effort, cached per instance.
let whoami = null;
async function accountEmail(token) {
  if (whoami !== null) return whoami;
  try { const r = await fetch(API + '/me', { headers: { 'X-Figma-Token': token } }); whoami = r.ok ? ((await r.json()).email || '') : ''; } catch { whoami = ''; }
  return whoami;
}

async function figma(path, token) {
  const r = await fetch(API + path, { headers: { 'X-Figma-Token': token } });
  if (r.status === 403 || r.status === 401 || r.status === 404) {
    const who = await accountEmail(token);
    const whoTxt = who ? `the workspace's Figma account (${who})` : "the workspace's Figma account";
    if (r.status === 404 && !who) throw err('figma_not_found', 'Figma could not find that file. Check the link.', 404);
    throw err('figma_denied', `This board is not open to ${whoTxt}. Ask whoever owns the board to share it with that address (view is enough), or to set the file's sharing to "Anyone with the link can view", then paste the link again. Or drop the exported frames instead.`, 403);
  }
  if (r.status === 429) throw err('figma_rate_limit', 'Figma is rate-limiting this token for a moment. Wait a minute and try again.', 429);
  if (!r.ok) throw err('figma_error', `Figma answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const box = n => n.absoluteBoundingBox || n.absoluteRenderBounds || {};
const frameOf = (n, section) => ({ id: n.id, name: n.name, type: n.type, w: Math.round(box(n).width || 0), h: Math.round(box(n).height || 0), section: section || null });

// Frames directly on a page, plus frames inside sections (one level). Groups of frames are opened one level too.
async function collect(fileKey, nodes, token) {
  const frames = []; const openIds = [];
  for (const n of nodes) {
    if (FRAME_TYPES.has(n.type)) frames.push(frameOf(n));
    else if (n.type === 'SECTION' || n.type === 'GROUP') { if (n.children) frames.push(...n.children.filter(c => FRAME_TYPES.has(c.type)).map(c => frameOf(c, n.name))); else openIds.push(n); }
  }
  // Sections returned without children (depth-limited): fetch them.
  for (let i = 0; i < openIds.length; i += 40) {
    const ids = openIds.slice(i, i + 40).map(n => n.id);
    const r = await figma(`/files/${fileKey}/nodes?ids=${encodeURIComponent(ids.join(','))}&depth=1`, token);
    for (const n of openIds.slice(i, i + 40)) { const doc = r.nodes?.[n.id]?.document; frames.push(...(doc?.children || []).filter(c => FRAME_TYPES.has(c.type)).map(c => frameOf(c, n.name))); }
  }
  return frames;
}

async function list(fileKey, nodeId, token) {
  if (nodeId) {
    const r = await figma(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=2`, token);
    const doc = r.nodes?.[nodeId]?.document;
    if (!doc) throw err('figma_not_found', 'That node is not in the file any more.', 404);
    let frames;
    if (doc.type === 'CANVAS' || doc.type === 'SECTION' || doc.type === 'GROUP') frames = await collect(fileKey, doc.children || [], token);
    else if (FRAME_TYPES.has(doc.type)) { const inner = (doc.children || []).filter(c => FRAME_TYPES.has(c.type)); frames = inner.length >= 2 && !/\d{5}-\d{6}/.test(doc.name) ? inner.map(c => frameOf(c, doc.name)) : [frameOf(doc)]; }
    else frames = [];
    return { fileKey, name: r.name || '', lastModified: r.lastModified || null, scoped: doc.name, pages: [{ id: doc.id, name: doc.type === 'CANVAS' ? doc.name : `${doc.name} (${doc.type.toLowerCase()})`, frames }] };
  }
  const f = await figma(`/files/${fileKey}?depth=2`, token);
  const pages = [];
  for (const page of f.document?.children || []) {
    if (page.type !== 'CANVAS') continue;
    pages.push({ id: page.id, name: page.name, frames: await collect(fileKey, page.children || [], token) });
  }
  return { fileKey, name: f.name || '', lastModified: f.lastModified || null, scoped: null, pages };
}

async function render(fileKey, ids, scale, format, token) {
  ids = ids.map(String).filter(Boolean).slice(0, 25);
  if (!ids.length) throw err('bad_request', 'No frames to render.', 400);
  const sc = Math.min(4, Math.max(0.1, Number(scale) || 1)); const fmt = ['png', 'jpg', 'svg', 'pdf'].includes(format) ? format : 'png';
  const r = await figma(`/images/${fileKey}?ids=${encodeURIComponent(ids.join(','))}&format=${fmt}&scale=${sc}&use_absolute_bounds=false`, token);
  if (r.err) throw err('figma_render', `Figma could not render: ${r.err}`);
  return { images: r.images || {} };
}

export const config = { path: '/api/figma' };
