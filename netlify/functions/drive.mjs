// AdAutonomy Drive reader.
//   POST /api/drive { url }        -> { folder, files:[{id,name,mimeType,size,path,modified}], folders:[path], truncated }
//   GET  /api/drive?file=<id>      -> the file's bytes (images, spreadsheets, xml), for the page to load as if dropped
// Needs GOOGLE_SA_EMAIL + GOOGLE_SA_KEY (folder shared with that account) or GOOGLE_API_KEY (folder shared as "Anyone with the link").
import { env, json, fail, err, checkAccess, googleToken, gapi } from './lib/google.mjs';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const WANT = /\.(png|jpe?g|webp|gif|csv|xlsx|xlsm|xml)$/i;

export default async (req) => {
  if (!checkAccess(req)) return new Response('Unauthorized', { status: 401 });
  const u = new URL(req.url);
  if (req.method === 'GET') {
    const id = u.searchParams.get('file');
    if (!id) return json({ ok: true, google: !!(env('GOOGLE_SA_EMAIL') || env('GOOGLE_API_KEY')) });
    try {
      const auth = await creds();
      const r = await gapi(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { ...auth, raw: true });
      return new Response(r.body, { status: 200, headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'private, max-age=300' } });
    } catch (e) { return fail(e.code || 'read_failed', e.message || String(e), e.status || 502); }
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body; try { body = await req.json(); } catch { return fail('bad_request', 'Send JSON with a url.'); }
  const m = String(body.url || '').match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|open\?id=)([A-Za-z0-9_-]+)/);
  if (!m) return fail('unknown_link', 'That is not a Google Drive folder link.');
  try {
    const auth = await creds();
    const root = await gapi(`https://www.googleapis.com/drive/v3/files/${m[1]}?fields=id,name,mimeType&supportsAllDrives=true`, auth);
    const files = [], folders = []; let truncated = false;
    const walk = async (id, path, depth) => {
      if (depth > 4 || files.length > 1500) { truncated = true; return; }
      let pageToken = null;
      do {
        const q = new URL('https://www.googleapis.com/drive/v3/files');
        q.searchParams.set('q', `'${id}' in parents and trashed = false`); q.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,modifiedTime)'); q.searchParams.set('pageSize', '1000'); q.searchParams.set('supportsAllDrives', 'true'); q.searchParams.set('includeItemsFromAllDrives', 'true');
        if (pageToken) q.searchParams.set('pageToken', pageToken);
        const j = await gapi(q.toString(), auth);
        for (const f of j.files || []) {
          if (f.mimeType === 'application/vnd.google-apps.folder') { folders.push(path + f.name + '/'); await walk(f.id, path + f.name + '/', depth + 1); }
          else if (f.mimeType === 'application/vnd.google-apps.spreadsheet') files.push({ id: f.id, name: f.name + ' (Google Sheet)', mimeType: f.mimeType, size: 0, path, modified: f.modifiedTime, sheet: true });
          else if (WANT.test(f.name)) files.push({ id: f.id, name: f.name, mimeType: f.mimeType, size: +f.size || 0, path, modified: f.modifiedTime });
        }
        pageToken = j.nextPageToken || null;
      } while (pageToken && files.length <= 1500);
    };
    await walk(root.id, '', 0);
    return json({ folder: root.name, files, folders, truncated });
  } catch (e) { return fail(e.code || 'read_failed', e.message || String(e), e.status || 502); }
};

async function creds() {
  const token = await googleToken(SCOPE); const apiKey = env('GOOGLE_API_KEY');
  if (!token && !apiKey) throw err('google_not_connected', 'Google Drive is not connected to this workspace yet. Ask John to add the Google credentials to the site.', 503);
  return { token, apiKey };
}

export const config = { path: '/api/drive' };
