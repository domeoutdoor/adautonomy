const http=require('http'), fs=require('fs'); const { chromium } = require('playwright');
const html=fs.readFileSync('index.html','utf8'); const CODE='test-code';
let connected=false; const log=[];
const srv=http.createServer(async (req,res)=>{
  log.push(req.method+' '+req.url);
  if (req.url.startsWith('/api/figma/auth')){ connected=true; res.statusCode=302; res.setHeader('location','/#review'); return res.end(); }
  if (req.url.startsWith('/api/')){
    if (req.method==='GET' && req.url==='/api/figma'){ res.setHeader('content-type','application/json'); return res.end(JSON.stringify({ok:true,figma:connected,connected,oauth:true})); }
    if (req.method==='GET' && req.url==='/api/review'){ res.setHeader('content-type','application/json'); return res.end(JSON.stringify({ok:true})); }
    if (req.headers['x-access-code']!==CODE){ res.statusCode=401; return res.end('Unauthorized'); }
    let body=''; for await (const c of req) body+=c; let j={}; try{ j=JSON.parse(body); }catch{}
    res.setHeader('content-type','application/json');
    if (req.url==='/api/figma'){
      if (!connected){ res.statusCode=401; return res.end(JSON.stringify({error:'figma_connect_required',message:'Connect your Figma account.'})); }
      if (j.action==='list') return res.end(JSON.stringify({fileKey:'K',name:'Mistletoe',pages:[{id:'5:1575',name:'Round 4',frames:[{id:'1:1',name:'MM5_Advertising_800x533px_US_EN_61049-053346',w:800,h:533,section:null}]}]}));
      if (j.action==='render'){ const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64'); return res.end(JSON.stringify({images:Object.fromEntries((j.ids||[]).map(id=>[id,`http://127.0.0.1:${srv.address().port}/img.png`]))})); }
    }
    return res.end(JSON.stringify({text:'{}'}));
  }
  if (req.url==='/img.png'){ res.setHeader('content-type','image/png'); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64')); }
  res.setHeader('content-type','text/html'); res.end(html);
});
(async()=>{
  await new Promise(r=>srv.listen(0,r)); const base=`http://127.0.0.1:${srv.address().port}/`;
  const browser=await chromium.launch(); const ctx=await browser.newContext(); const page=await ctx.newPage(); const out={};
  await page.goto(base+'#k='+CODE); await page.waitForTimeout(500);
  await page.fill('#ov-link','https://www.figma.com/design/KEY123/Mistletoe?node-id=5-1575'); await page.click('#ov-go');
  await page.waitForSelector('#dlg-prompt[open]',{timeout:8000});
  out.dialog={ title: await page.textContent('#dp-title'), ok: await page.textContent('#dp-ok'), input: await page.isVisible('#dp-input') };
  await Promise.all([ page.waitForURL(/#review/, {timeout:8000}), page.click('#dp-ok') ]);
  await page.waitForTimeout(2500);
  // after the redirect "back from Figma", the board should load by itself
  out.afterReturn={ url: page.url(), pending: await page.evaluate(()=>localStorage.getItem('ada:pendingFigma')), dlgOpen: await page.isVisible('#dlg-drive[open]').catch(()=>false), drivePick: await page.textContent('#dlg-drive').catch(()=>null) };
  out.calls=log.filter(l=>/api\/figma/.test(l));
  await browser.close(); srv.close(); console.log(JSON.stringify(out,null,1));
})().catch(e=>{ console.error(e); process.exit(1); });
