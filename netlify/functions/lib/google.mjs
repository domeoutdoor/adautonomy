// Shared helpers for the AdAutonomy endpoints.
export const env = (k, d) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? d);
export const json = (o, status = 200) => Response.json(o, { status });
export const fail = (code, message, status = 400) => json({ error: code, message }, status);
export const err = (code, message, status = 502) => Object.assign(new Error(message), { code, status });

export function checkAccess(req) {
  const access = env('REVIEWER_ACCESS_CODE', '');
  return !access || req.headers.get('x-access-code') === access;
}

// Service-account token (GOOGLE_SA_EMAIL + GOOGLE_SA_KEY). Returns null when not configured.
export async function googleToken(scope) {
  const email = env('GOOGLE_SA_EMAIL'), key = env('GOOGLE_SA_KEY');
  if (!email || !key) return null;
  const { createSign } = await import('node:crypto');
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const signer = createSign('RSA-SHA256'); signer.update(unsigned);
  const sig = signer.sign(key.replace(/\\n/g, '\n')).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${sig}` });
  if (!r.ok) throw err('sa_token', 'Google would not issue a token for the service account: ' + (await r.text()).slice(0, 200));
  return (await r.json()).access_token;
}

// Authenticated Google API call: service account when configured, otherwise an API key (public items only).
export async function gapi(url, { token, apiKey, raw } = {}) {
  const u = new URL(url); const headers = {};
  if (token) headers.authorization = `Bearer ${token}`; else if (apiKey) u.searchParams.set('key', apiKey);
  const r = await fetch(u, { headers });
  if (r.status === 401 || r.status === 403 || r.status === 404) {
    const who = env('GOOGLE_SA_EMAIL');
    throw err('not_shared', who ? `Google will not open this item for the workspace account. Share it with ${who} as Viewer.` : 'Google will not open this item. Share it as "Anyone with the link" (Viewer), or ask John to connect the workspace Google account.', 403);
  }
  if (!r.ok) throw err('google_error', `Google answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return raw ? r : r.json();
}

export function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c; }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
