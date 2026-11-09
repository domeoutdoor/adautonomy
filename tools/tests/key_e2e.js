const http=require('http'), fs=require('fs'), path=require('path');
const { chromium } = require('playwright');
const html=fs.readFileSync('/home/claude/dist/index.html','utf8');
const CODE='test-code';
const srv=http.createServer((req,res)=>{
  if (req.url.startsWith('/api/')){
    if (req.method==='GET' && req.url==='/api/figma'){ res.setHeader('content-type','application/json'); return res.end(JSON.stringify({ok:true,figma:false})); }
    if (req.method==='GET' && req.url==='/api/review'){ res.setHeader('content-type','application/json'); return res.end(JSON.stringify({ok:true})); }
    if (req.headers['x-access-code']!==CODE){ res.statusCode=401; return res.end('Unauthorized'); }
    res.setHeader('content-type','application/json');
    if (req.url==='/api/figma'){ res.statusCode=401; return res.end(JSON.stringify({error:'figma_token_required',message:'Board reading is not connected on this workspace yet.'})); }
    return res.end(JSON.stringify({text:'{}'}));
  }
  res.setHeader('content-type','text/html'); res.end(html);
});
(async()=>{
  await new Promise(r=>srv.listen(0,r)); const port=srv.address().port; const base=`http://127.0.0.1:${port}/`;
  const browser=await chromium.launch(); const out={};
  // 1) Fresh browser, bare link, paste a figma link -> explanation dialog, no input, no token prompt
  let ctx=await browser.newContext(); let page=await ctx.newPage();
  await page.goto(base); await page.waitForTimeout(600);
  await page.fill('#ov-link','https://www.figma.com/design/abc123XYZ/Test?node-id=1-2'); await page.click('#ov-go');
  await page.waitForSelector('#dlg-prompt[open]',{timeout:8000});
  out.bare={ title: await page.textContent('#dp-title'), inputVisible: await page.isVisible('#dp-input'), selVisible: await page.isVisible('#dp-select'), hasAccessDlg: !!(await page.$('#dlg-access')) };
  await page.click('#dp-ok'); await page.waitForTimeout(300);
  // second attempt: no second dialog, toast instead
  await page.fill('#ov-link','https://www.figma.com/design/abc123XYZ/Test?node-id=1-2'); await page.click('#ov-go'); await page.waitForTimeout(800);
  out.bareSecond={ dlgOpen: await page.isVisible('#dlg-prompt[open]') };
  await ctx.close();
  // 2) Link with key: stored, hash cleaned, figma call reaches token check
  ctx=await browser.newContext(); page=await ctx.newPage();
  await page.goto(base+'#k='+CODE); await page.waitForTimeout(600);
  out.keyed={ hash: await page.evaluate(()=>location.hash), stored: await page.evaluate(()=>localStorage.getItem('ada:access')) };
  await page.fill('#ov-link','https://www.figma.com/design/abc123XYZ/Test?node-id=1-2'); await page.click('#ov-go');
  await page.waitForSelector('#dlg-prompt[open]',{timeout:8000});
  out.keyed.title=await page.textContent('#dp-title'); out.keyed.inputVisible=await page.isVisible('#dp-input');
  await page.click('#dp-ok');
  // reload without key -> still remembered
  await page.goto(base+'#review'); await page.waitForTimeout(400);
  out.keyed.afterReload={ hash: await page.evaluate(()=>location.hash), stored: await page.evaluate(()=>localStorage.getItem('ada:access')) };
  // 3) key with view: #review&k=
  await page.evaluate(()=>localStorage.removeItem('ada:access'));
  await page.goto(base+'#review&k='+CODE); await page.waitForTimeout(400);
  out.keyedView={ hash: await page.evaluate(()=>location.hash), stored: await page.evaluate(()=>localStorage.getItem('ada:access')) };
  // 4) query form ?k=
  await page.evaluate(()=>localStorage.removeItem('ada:access'));
  await page.goto(base+'?k='+CODE); await page.waitForTimeout(400);
  out.query={ url: await page.evaluate(()=>location.pathname+location.search+location.hash), stored: await page.evaluate(()=>localStorage.getItem('ada:access')) };
  await browser.close(); srv.close(); console.log(JSON.stringify(out,null,1));
})().catch(e=>{ console.error(e); process.exit(1); });
