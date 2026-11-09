// AdAutonomy reviewer endpoint.
// Serves GET /api/review (health) and POST /api/review (a review request from the page).
// Environment variables (set in the Netlify site settings, never in this file):
//   REVIEWER_API_KEY       the key for the model provider below (required)
//   REVIEWER_ACCESS_CODE   optional shared code the page must send; leave unset to allow any visitor of the site
//   REVIEWER_MODEL_QUICK / REVIEWER_MODEL_DEFAULT / REVIEWER_MODEL_COMPLEX   optional model ids per depth setting
//   REVIEWER_API_URL       optional; defaults to the provider's messages endpoint
// The provider call is isolated in callModel() so another provider can be swapped in without touching the page.

const env = (k, d) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? d);

export default async (req) => {
  const key = env('REVIEWER_API_KEY');
  if (req.method === 'GET') return Response.json({ ok: !!key, images: true });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const access = env('REVIEWER_ACCESS_CODE', '');
  if (access && req.headers.get('x-access-code') !== access) return new Response('Unauthorized', { status: 401 });
  if (!key) return new Response('REVIEWER_API_KEY is not set on the site', { status: 500 });

  let body; try { body = await req.json(); } catch { return new Response('Bad request', { status: 400 }); }
  const { messages = [], images = [], tier = 'default', json = false } = body;
  if (!Array.isArray(messages) || !messages.length) return new Response('No messages', { status: 400 });
  if (images.length > 8) return new Response('Too many images in one request', { status: 400 });

  try {
    const out = await callModel({ key, messages, images, tier, json });
    return Response.json(out);
  } catch (e) {
    const status = e.status === 429 ? 429 : 502;
    return new Response(String(e.message || e), { status });
  }
};

async function callModel({ key, messages, images, tier, json }) {
  const models = {
    quick:   env('REVIEWER_MODEL_QUICK',   'claude-haiku-5-5'),
    default: env('REVIEWER_MODEL_DEFAULT', 'claude-sonnet-5-5'),
    complex: env('REVIEWER_MODEL_COMPLEX', 'claude-opus-5-5'),
  };
  const model = models[tier] || models.default;
  const msgs = messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: String(m.content || '') }] }));
  if (images.length) {
    const last = msgs[msgs.length - 1];
    last.content = [
      ...images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.media_type || 'image/jpeg', data: im.data } })),
      ...last.content,
    ];
  }
  const payload = { model, max_tokens: 4096, messages: msgs };
  if (json) payload.system = 'Reply with only valid JSON. No prose before or after it.';
  const r = await fetch(env('REVIEWER_API_URL', 'https://api.anthropic.com/v1/messages'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) { const err = new Error(await r.text()); err.status = r.status; throw err; }
  const data = await r.json();
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { text, truncated: data.stop_reason === 'max_tokens' };
}

export const config = { path: '/api/review' };
