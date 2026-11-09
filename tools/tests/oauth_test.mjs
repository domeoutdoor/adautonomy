// Drive the function handler directly with a fake Figma: auth -> callback -> POST list (with cookie) -> status.
process.env.FIGMA_CLIENT_ID='cid123'; process.env.FIGMA_CLIENT_SECRET='sec456'; process.env.REVIEWER_ACCESS_CODE='test-code'; process.env.URL='https://adautonomy-qc.netlify.app';
const realFetch = globalThis.fetch; const calls=[];
globalThis.fetch = async (input, init={}) => {
  const url = typeof input==='string'? input : input.toString(); calls.push({url, auth: init.headers?.authorization||init.headers?.Authorization||null, body: init.body? String(init.body):null});
  if (url.startsWith('https://api.figma.com/v1/oauth/token')) return new Response(JSON.stringify({ user_id:'u1', access_token:'figu_ACCESS', refresh_token:'figur_REFRESH', expires_in: 7776000 }), { status:200, headers:{'content-type':'application/json'} });
  if (url.startsWith('https://api.figma.com/v1/me')) return new Response(JSON.stringify({ email:'joanna.cosenza@icpnet.com' }), { status:200 });
  if (url.includes('/v1/files/KEY123/nodes')) return new Response(JSON.stringify({ name:'Mistletoe', nodes:{ '5:1575': { document:{ id:'5:1575', type:'CANVAS', name:'Round 4', children:[ { id:'1:1', type:'FRAME', name:'MM5_Advertising_800x533px_US_EN_61049-053346', absoluteBoundingBox:{width:800,height:533} }, { id:'1:2', type:'SECTION', name:'Apple', children:[ { id:'1:3', type:'FRAME', name:'MM5_Apple_1200x1500_US_EN_61049-057380', absoluteBoundingBox:{width:1200,height:1501} } ] } ] } } } }), { status:200 });
  return new Response('nope', { status: 500 });
};
const mod = await import('netlify/functions/figma.mjs'); const h = mod.default;
const r1 = await h(new Request('https://adautonomy-qc.netlify.app/api/figma/auth?return=' + encodeURIComponent('https://adautonomy-qc.netlify.app/#review')));
const loc1 = r1.headers.get('location'); const stateCookie = r1.headers.get('set-cookie');
const state = new URL(loc1).searchParams.get('state');
console.log('auth ->', r1.status, loc1.split('?')[0], 'scope=', new URL(loc1).searchParams.get('scope'), 'redirect_uri=', new URL(loc1).searchParams.get('redirect_uri'));
const r2 = await h(new Request(`https://adautonomy-qc.netlify.app/api/figma/callback?code=abc&state=${encodeURIComponent(state)}`, { headers:{ cookie: stateCookie.split(';')[0] } }));
const sc = r2.headers.getSetCookie ? r2.headers.getSetCookie() : [r2.headers.get('set-cookie')];
const grantCookie = sc.find(c=>c.startsWith('ada_fig=')).split(';')[0];
console.log('callback ->', r2.status, r2.headers.get('location'), 'cookies:', sc.map(c=>c.split('=')[0]+'('+(c.includes('Max-Age=0')?'cleared':'set')+')').join(','));
console.log('token exchange used basic auth:', calls.find(c=>c.url.includes('oauth/token'))?.auth?.startsWith('Basic '), 'body:', calls.find(c=>c.url.includes('oauth/token'))?.body);
const r3 = await h(new Request('https://adautonomy-qc.netlify.app/api/figma', { method:'POST', headers:{ 'content-type':'application/json', 'x-access-code':'test-code', cookie: grantCookie }, body: JSON.stringify({ url:'https://www.figma.com/design/KEY123/Mistletoe?node-id=5-1575', action:'list' }) }));
const j3 = await r3.json(); console.log('list ->', r3.status, JSON.stringify(j3.pages?.[0]?.frames));
console.log('files call used bearer:', calls.find(c=>c.url.includes('/files/'))?.auth);
const r4 = await h(new Request('https://adautonomy-qc.netlify.app/api/figma', { headers:{ cookie: grantCookie } })); console.log('status ->', await r4.text());
const r5 = await h(new Request('https://adautonomy-qc.netlify.app/api/figma', { method:'POST', headers:{ 'content-type':'application/json', 'x-access-code':'test-code' }, body: JSON.stringify({ url:'https://www.figma.com/design/KEY123/M', action:'list' }) })); console.log('no cookie ->', r5.status, await r5.text());
const r6 = await h(new Request('https://adautonomy-qc.netlify.app/api/figma/disconnect?return=%2F%23overview')); console.log('disconnect ->', r6.status, r6.headers.get('location'), r6.headers.get('set-cookie'));
const r7 = await h(new Request('https://adautonomy-qc.netlify.app/api/figma/callback?code=abc&state=WRONG', { headers:{ cookie: stateCookie.split(';')[0] } })); console.log('bad state ->', r7.status, r7.headers.get('location'));
