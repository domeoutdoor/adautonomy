process.env.FIGMA_TOKEN='figd_x'; process.env.REVIEWER_ACCESS_CODE='test-code'; process.env.URL='https://adautonomy-qc.netlify.app';
const calls=[];
const F=(id,name,children,type='FRAME',w=100,h=100)=>({id,name,type,absoluteBoundingBox:{width:w,height:h},...(children!==undefined?{children}:{})});
const tree={ // depth-2 file response: pages with children but grandchildren omitted
  '0:1': F('0:1','R6',[ F('a','Main Components',undefined,'FRAME',12654,1987), F('b','STATUS',undefined,'FRAME',333,487), F('c','Advertising',undefined,'FRAME',2603,2463), F('d','MM5_AudiblePDP_488x173_US_EN_61049-057734',undefined,'FRAME',488,173), F('e','Apple',undefined,'FRAME',2120,3826) ],'CANVAS'),
};
const nodes={
  'c': F('c','Advertising',[ F('c1','Title',undefined,'FRAME',543,168), F('c2','Layout design',undefined,'FRAME',2403,1245), F('c3','1080X1080',undefined,'FRAME',1158,650) ]),
  'c2': F('c2','Layout design',[ F('c21','MM5_Advertising_800x533px_US_EN_61049-053346',undefined,'FRAME',800,533), F('c22','MM5_Advertising_665x502_US_EN_61049-053349',undefined,'FRAME',665,502), { id:'c23', name:'copy', type:'TEXT' } ]),
  'c3': F('c3','1080X1080',[ { id:'c31', name:'img', type:'RECTANGLE' } ]),
  'e': F('e','Apple',[ F('e1','Title',undefined,'FRAME',317,168), F('e2','1920x1080',undefined,'FRAME',1920,1209), F('e3','Auto layout',undefined,'FRAME',1098,2049) ]),
  'e2': F('e2','1920x1080',[ F('e21','MM5_Apple_1920x1080_US_EN_61042-058768',undefined,'FRAME',1920,1080) ]),
  'e3': F('e3','Auto layout',[ F('e31','MM5_Apple_1080x1920_US_EN_61042-058769',undefined,'FRAME',1080,1920), F('e32','MM5_Apple_5244x2950_US_EN_61042-058767',undefined,'FRAME',5244,2950) ]),
  'a': F('a','Main Components',[ F('a1','MM5_FAKE_10x10_US_EN_11111-111111') ]), 'b': F('b','STATUS',[]),
};
globalThis.fetch = async (input) => { const url=String(input); calls.push(url.replace('https://api.figma.com/v1',''));
  if (url.includes('/files/KEY?')) return new Response(JSON.stringify({ name:'Board', document:{ children:[ {id:'0:1',name:'R6',type:'CANVAS'} ] } }), {status:200});
  const m=url.match(/\/nodes\?ids=([^&]+)/); if (m){ const ids=decodeURIComponent(m[1]).split(','); const out={}; for (const id of ids) out[id]={ document: id==='0:1' ? tree['0:1'] : (nodes[id] || F(id,'?',[])) }; return new Response(JSON.stringify({ name:'Board', nodes: out }), {status:200}); }
  return new Response('no',{status:500}); };
const h=(await import('netlify/functions/figma.mjs')).default;
const r=await h(new Request('https://adautonomy-qc.netlify.app/api/figma',{method:'POST',headers:{'content-type':'application/json','x-access-code':'test-code'},body:JSON.stringify({url:'https://www.figma.com/design/KEY/Board',action:'list'})}));
const j=await r.json(); console.log(JSON.stringify(j.pages[0].frames.map(f=>`${f.name} ${f.w}x${f.h} [${f.section}]`),null,1)); console.log('api calls:', calls.length, calls);
