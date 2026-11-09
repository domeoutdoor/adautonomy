// AdAutonomy order reader.  POST /api/sheet { url, tab? } -> { source, title, tab, tabs?, rows: string[][] }
// Google Sheets: link-shared sheets need no setup (CSV export). Private sheets need GOOGLE_SA_EMAIL + GOOGLE_SA_KEY
// and the sheet shared with that account; tabs can then be listed and chosen by name. GOOGLE_API_KEY also works for public sheets.
// Airtable: "x-airtable-token" header (personal access token with data.records:read) or AIRTABLE_TOKEN on the site.
import { env, json, fail, err, checkAccess, googleToken, gapi, parseCSV } from './lib/google.mjs';

export default async (req) => {
  if (req.method === 'GET') return json({ ok: true, google: !!(env('GOOGLE_SA_EMAIL') || env('GOOGLE_API_KEY')), airtable: !!env('AIRTABLE_TOKEN') });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!checkAccess(req)) return new Response('Unauthorized', { status: 401 });
  let body; try { body = await req.json(); } catch { return fail('bad_request', 'Send JSON with a url.'); }
  const url = String(body.url || '').trim(); const tab = String(body.tab || '').trim();
  if (!url) return fail('bad_request', 'Paste a link first.');
  try {
    const g = url.match(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
    if (g) { const out = await readGoogle(g[1], tab, url); return out instanceof Response ? out : json(out); }
    const a = url.match(/airtable\.com\/(app[A-Za-z0-9]+)\/(tbl[A-Za-z0-9]+)(?:\/(viw[A-Za-z0-9]+))?/);
    if (a) return json(await readAirtable(a[1], a[2], a[3], req.headers.get('x-airtable-token') || env('AIRTABLE_TOKEN', '')));
    if (/airtable\.com\/(shr|app)/.test(url)) return fail('airtable_link', 'Open the table in Airtable and copy the address from the browser bar (it contains app…, tbl… and usually viw…). Share links cannot be read.');
    return fail('unknown_link', 'That is not a Google Sheets or Airtable link.');
  } catch (e) { return fail(e.code || 'read_failed', e.message || String(e), e.status || 502); }
};

// The whole workbook is read, every tab. `tab`, when given, only marks which tab is this round's order; the client
// still sees the other tabs (master UAIDs, dupes, earlier rounds) and merges them.
async function readGoogle(id, tab, url) {
  const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1] || null;
  const token = await googleToken('https://www.googleapis.com/auth/spreadsheets.readonly'); const apiKey = env('GOOGLE_API_KEY');
  if (token || apiKey) {
    const meta = await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,sheets.properties`, { token, apiKey });
    const tabs = (meta.sheets || []).map(s => ({ title: s.properties.title, gid: String(s.properties.sheetId) }));
    if (!tabs.length) throw err('no_tabs', 'The workbook has no tabs.', 404);
    let focus = null;
    if (tab) focus = tabs.find(t => t.title.toLowerCase() === tab.toLowerCase()) || tabs.find(t => t.title.toLowerCase().includes(tab.toLowerCase()));
    if (!focus && gid) focus = tabs.find(t => t.gid === gid);
    const q = tabs.map(t => 'ranges=' + encodeURIComponent("'" + t.title.replace(/'/g, "''") + "'")).join('&');
    const batch = await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${q}&valueRenderOption=FORMATTED_VALUE`, { token, apiKey });
    const ranges = batch.valueRanges || [];
    const sheets = tabs.map((t, i) => ({ title: t.title, rows: ranges[i]?.values || [] }));
    const first = focus ? sheets.find(s => s.title === focus.title) : sheets[0];
    return { source: 'google', title: meta.properties?.title || '', tab: focus ? focus.title : null, tabs: tabs.map(t => t.title), sheets, rows: first?.rows || [] };
  }
  // No Google credentials on the site: a link-shared workbook can still be exported whole as .xlsx.
  const x = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, { redirect: 'follow', headers: { 'user-agent': 'AdAutonomy/1.0' } });
  const xct = x.headers.get('content-type') || '';
  if (x.status === 401 || x.status === 403 || /text\/html/.test(xct)) throw err('private_sheet', 'This sheet is private. In Google Sheets choose Share, then "Anyone with the link" as Viewer, and try again. Or ask John to connect the workspace Google account so private sheets can be read.', 403);
  if (x.ok && /spreadsheetml|octet-stream|zip/.test(xct)) {
    const bytes = new Uint8Array(await x.arrayBuffer());
    if (bytes.length > 5_500_000) throw err('too_large', 'That workbook is over 5 MB. Drop the tracker as a file instead.', 413);
    return new Response(bytes, { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-ada-source': 'google', 'x-ada-tab': encodeURIComponent(tab || ''), 'cache-control': 'no-store' } });
  }
  // Last resort: one tab as CSV.
  let csvUrl;
  if (tab) csvUrl = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  else if (gid) csvUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  else csvUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
  const r = await fetch(csvUrl, { redirect: 'follow', headers: { 'user-agent': 'AdAutonomy/1.0' } });
  const ct = r.headers.get('content-type') || '';
  if (r.status === 401 || r.status === 403 || /text\/html/.test(ct)) throw err('private_sheet', 'This sheet is private. In Google Sheets choose Share, then "Anyone with the link" as Viewer, and try again. Or ask John to connect the workspace Google account so private sheets can be read.', 403);
  if (!r.ok) throw err('google_error', `Google answered ${r.status}.`);
  const text = await r.text();
  if (tab && /^\s*<|"error"|Invalid query parameter/i.test(text.slice(0, 200))) throw err('no_such_tab', `No tab named "${tab}" in that workbook (the name must match exactly).`, 404);
  return { source: 'google', title: '', tab: tab || (gid ? `gid ${gid}` : 'first tab'), rows: parseCSV(text) };
}

async function readAirtable(base, table, view, token) {
  if (!token) throw err('airtable_token_required', 'An Airtable personal access token is needed to read this table.', 401);
  const records = []; let offset = null; const fields = new Map();
  do {
    const u = new URL(`https://api.airtable.com/v0/${base}/${table}`);
    if (view) u.searchParams.set('view', view); u.searchParams.set('pageSize', '100'); u.searchParams.set('cellFormat', 'string'); u.searchParams.set('timeZone', 'America/New_York'); u.searchParams.set('userLocale', 'en-us');
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 401 || r.status === 403) throw err('airtable_denied', 'Airtable refused the token for this base. The token needs data.records:read on it.', 403);
    if (!r.ok) throw err('airtable_error', `Airtable answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    for (const rec of j.records || []) { records.push(rec.fields || {}); for (const k of Object.keys(rec.fields || {})) fields.set(k, true); }
    offset = j.offset || null;
  } while (offset && records.length < 5000);
  const headers = [...fields.keys()];
  const rows = [headers, ...records.map(f => headers.map(h => { const v = f[h]; return Array.isArray(v) ? v.map(x => (x && typeof x === 'object') ? (x.name || x.filename || x.url || '') : x).join(', ') : (v == null ? '' : String(v)); }))];
  return { source: 'airtable', title: `${base}/${table}`, tab: view || '', rows };
}

export const config = { path: '/api/sheet' };
