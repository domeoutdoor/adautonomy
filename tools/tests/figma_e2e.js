// Local end-to-end check of the Figma + Sheets link flow against stubbed endpoints.
const http = require('http'), fs = require('fs'), zlib = require('zlib'), path = require('path');
const { chromium } = require('playwright');
const DIST = '/home/claude/dist';

function png(w, h, rgb) { // minimal solid PNG
  const crc = (buf) => { let c, table = png.table || (png.table = (() => { const t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })()); c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const FRAMES = {
  'Round 4': [
    { id: '10:1', name: 'MM5_Goodreads_970x250_US_EN_61049-041538', w: 970, h: 250 },
    { id: '10:2', name: 'MM5_Advertising_520x520_US_EN_61049-053344', w: 521, h: 521 },
    { id: '10:3', name: 'MM5_AudibleWeb_320x192_US_EN_61049-041524', w: 320, h: 192 },
    { id: '10:4', name: 'MM5_AudiblePDP_345x268_US_EN_61049-057734_Mockup', w: 345, h: 268, section: 'PDP' },
    { id: '10:5', name: 'Notes for studio', w: 800, h: 600 },
  ],
  'Archive R1-R3': [{ id: '20:1', name: 'MM5_Email_580x360_US_EN_61049-041528', w: 580, h: 360 }],
  'Scratch': [{ id: '30:1', name: 'Frame 12', w: 100, h: 100 }],
};
const ALL = Object.values(FRAMES).flat();
const log = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); log.push(req.method + ' ' + u.pathname + (u.search || ''));
  const body = () => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d ? JSON.parse(d) : {})); });
  const send = (o, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/api/review') return send({ ok: false, images: false });
  if (u.pathname === '/api/sheet') return body().then(b => {
    if (b.tab && b.tab !== 'Round 4') return send({ error: 'no_such_tab', message: `No tab named "${b.tab}". This workbook has: Overview, Round 4, Round 3.` }, 404);
    send({ source: 'google', title: 'Audible MM5 Tracker', tab: 'Round 4', tabs: ['Overview', 'Round 4', 'Round 3'], rows: [
      ['CLOSED'], ['AXIOM JOB NO', 'STUDIO STATUS', 'UAID', 'File Naming Convention (Auto-generated)', 'Creative Vendor', 'Dimensions', 'CTA Type', 'CTA', 'Copy on Asset', 'Detailed Requirements', 'File Format', 'Partner/Surface'],
      ['280268', 'READY TO BUILD', '61049-041538', 'MM5_Goodreads_970x250_US_EN_61049-041538.png', 'ICP', '970x250', '', '', '', '', 'png', 'Goodreads'],
      ['280268', 'READY TO BUILD', '61049-053344', 'MM5_Advertising_520x520_US_EN_61049-053344.png', 'ICP', '520x520', '', '', '', '', 'png', 'AoA'],
      ['280268', 'READY TO BUILD', '61049-041524', 'MM5_AudibleWeb_320x192_US_EN_61049-041524.png', 'ICP', '320x192', '', '', '', '', 'png', 'Audible Web'],
      ['280268', 'READY TO BUILD', '61049-057734', 'MM5_AudiblePDP_488x173_US_EN_61049-057734.png', 'ICP', '488x173', '', '', '', 'Black and white', 'png', 'PDP'],
      ['280268', 'READY TO BUILD', '61049-000001', 'MM5_Reddit_1080x1080_US_EN_61049-000001.png', 'ICP', '1080x1080', '', '', '', '', 'png', 'Reddit'],
    ] });
  });
  if (u.pathname === '/api/figma' && req.method === 'POST') return body().then(b => {
    if (!SERVER_HAS_KEY && !req.headers['x-figma-token']) return send({ error: 'figma_token_required', message: 'Reading a Figma board needs a personal access token from an account that can view the file.' }, 401);
    if (b.action === 'render') { const images = {}; for (const id of b.ids) images[id] = ALL.find(f => f.id === id) ? `http://127.0.0.1:${PORT}/img/${encodeURIComponent(id)}.png` : null; return send({ images }); }
    send({ fileKey: 'abc123', name: 'MM5 Audible Banners', lastModified: '2026-11-08T18:22:00Z', scoped: null, pages: Object.entries(FRAMES).map(([name, frames], i) => ({ id: `${i}:0`, name, frames })) });
  });
  if (u.pathname.startsWith('/img/')) { const id = decodeURIComponent(u.pathname.slice(5).replace(/\.png$/, '')); const f = ALL.find(x => x.id === id); if (!f) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png(f.w, f.h, [40, 60, 90])); }
  let p = u.pathname === '/' ? '/index.html' : u.pathname; const fp = path.join(DIST, p);
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) { res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); return res.end(fs.readFileSync(fp)); }
  res.writeHead(404); res.end('nf');
});
let PORT; let SERVER_HAS_KEY = false;
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); PORT = server.address().port;
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForTimeout(600);
  // Beta access code dialog may be gated; set code in storage first
  await page.evaluate(() => { try { localStorage.setItem('ada:code', JSON.stringify('test-code')); } catch (e) {} });
  await page.reload(); await page.waitForTimeout(600);
  // 1. paste both links at once, with the tab named in prose
  await page.fill('#ov-link', 'go to the Round 4 tab in https://docs.google.com/spreadsheets/d/1XYZ/edit#gid=0 and review what was made in https://www.figma.com/design/abc123/MM5-Audible?node-id=0-1');
  await page.click('#ov-go');
  // token prompt
  await page.waitForSelector('#dlg-prompt[open]', { timeout: 8000 });
  console.log('no-key dialog:', await page.textContent('#dp-title'), '|', (await page.textContent('#dp-body')).slice(0,80), '| input shown:', await page.$eval('#dp-inwrap', e=>!e.hidden));
  await page.click('#dp-ok');
  SERVER_HAS_KEY = true;
  await page.fill('#rv-link', 'https://www.figma.com/design/abc123/MM5-Audible'); await page.click('#rv-go');
  await page.waitForSelector('#dlg-drive[open]', { timeout: 8000 });
  console.log('board title:', await page.textContent('#dd-title'));
  console.log('summary:', (await page.textContent('#dd-summary')).trim());
  console.log('pages:', await page.$$eval('#dd-tree li', lis => lis.map(l => (l.querySelector('input').checked ? '[x] ' : '[ ] ') + l.textContent.trim())));
  await page.screenshot({ path: '/tmp/claude-0/-home-claude/c5896c0e-5aa0-582a-9a46-da3833f0f5ac/scratchpad/shot_figma_dlg.png' });
  await page.click('#dd-load');
  await page.waitForFunction(() => !document.querySelector('#dlg-drive').open, null, { timeout: 15000 });
  await page.waitForTimeout(800);
  console.log('view:', await page.evaluate(() => location.hash));
  console.log('stat:', (await page.textContent('#rv-stat')).replace(/\s+/g, ' '));
  console.log('findings:', await page.$$eval('#rv-findings .bucket', bs => bs.map(b => b.querySelector('h4').textContent.trim() + ' :: ' + [...b.querySelectorAll('.find .fn')].map(x => x.textContent).join(' | '))));
  console.log('assets:', await page.evaluate(() => S.round.assets.map(a => `${a.name} ${a.w}x${a.h} via=${a.via} figma=${a.figma ? a.figma.page : '-'}`)));
  await page.screenshot({ path: '/tmp/claude-0/-home-claude/c5896c0e-5aa0-582a-9a46-da3833f0f5ac/scratchpad/shot_figma_review.png' });
  // 2. campaign page sources
  await page.evaluate(() => go('campaigns')); await page.waitForTimeout(400);
  console.log('sources:', (await page.textContent('#cd-sources')).replace(/\s+/g, ' ').slice(0, 900));
  // 3. link pasted into the conversation
  await page.evaluate(() => go('review')); await page.waitForTimeout(300);
  await page.fill('#ch-in', 'https://www.figma.com/design/abc123/MM5-Audible'); await page.press('#ch-in', 'Enter');
  await page.waitForSelector('#dlg-drive[open]', { timeout: 8000 }); console.log('chat link opened board dialog:', await page.textContent('#dd-title')); await page.click('#dd-cancel');
  console.log('chat log:', await page.$$eval('#ch-log .msg', ms => ms.map(m => m.className + ': ' + m.textContent.slice(0, 80))));
  console.log('requests:', log.filter(l => l.startsWith('POST')).join(' ; '));
  console.log('errors:', errors);
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
