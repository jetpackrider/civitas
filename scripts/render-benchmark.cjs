// Compare real Canvas rendering on a dense county, using an isolated development profile.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {_electron:electron}=require('playwright');
const {spawnSync}=require('node:child_process');
const {hash}=require('./data-integrity.cjs');
(async()=>{
 const source=process.argv[2]||'.',label=process.argv[3]||'current';
 if(!/^[A-Za-z0-9_-]+$/.test(label))throw Error('Use a filename-safe benchmark label.');
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'civitas-render-'));let app;
 try {
  const env={...process.env,CIVITAS_TEST_HIDE_WINDOW:'1'};delete env.ELECTRON_RUN_AS_NODE;
  delete env.CIVITAS_TEST_WEB_ROOT;
  app=await electron.launch({args:[source,`--user-data-dir=${profile}`],env});
  await app.context().route('https://**',r=>r.abort());
  const page=await app.firstWindow();page.on('pageerror',e=>console.error('Renderer',e.message));await page.waitForFunction(()=>!!window.CivitasApp);await page.selectOption('#home-geo-select','precinct');await page.locator('#home-create-btn').dispatchEvent('click');await page.waitForFunction(()=>!document.getElementById('app-view').hidden);
  await page.evaluate(()=>CivitasApp.ready());
  const result=await page.evaluate(async()=>{
   const doc=await (await fetch('data/block-v1/CA/geometry/precincts-los-angeles.json')).json();
   const shapes=doc.records.map(r=>({...r,_id:r.county+'|'+r.precinct,rings:r.d.split(' Z').filter(s=>s.trim()).map(s=>s.trim().replace(/^M\s*/,'').split(/\s+/).map(p=>p.split(',').map(Number))),paths:[null,null,null],fill:'#2375cb',districtId:null,bboxArea:(r.bbox[2]-r.bbox[0])*(r.bbox[3]-r.bbox[1]),dem:10,rep:0,other:0,margin:1}));
   CivitasApp.editor.initialize(shapes);await CivitasApp.editor.ready;
   const render=()=>document.getElementById('border-slider').dispatchEvent(new Event('input'));
   const firstStart=performance.now();render();const firstMeasuredRenderMilliseconds=performance.now()-firstStart;
   render();
   const samples=[];for(let i=0;i<30;i++){const start=performance.now();render();samples.push(performance.now()-start);}
   const sorted=[...samples].sort((a,b)=>a-b);
   return {shapes:shapes.length,vertices:shapes.reduce((n,s)=>n+s.rings.reduce((m,r)=>m+r.length,0),0),firstMeasuredRenderMilliseconds,samplesMilliseconds:samples,medianMilliseconds:sorted[15],p95Milliseconds:sorted[28],viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},view:CivitasApp.getView(),rendererHeap:performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null};
  });
  await fs.mkdir('dist',{recursive:true});await page.screenshot({path:`dist/render-${label}.png`});
  const runtime=await app.evaluate(({app})=>({versions:process.versions,processes:app.getAppMetrics().map(p=>({type:p.type,memory:p.memory,cpu:p.cpu}))}));
  const revision=spawnSync('git',['-C',path.resolve(source),'rev-parse','HEAD'],{encoding:'utf8'});
  const record={schemaVersion:1,label,recordedAt:new Date().toISOString(),scope:'Los Angeles synchronous canvas draw after initialization; synthetic election colors',commit:revision.status===0?revision.stdout.trim():null,hardware:{platform:os.platform(),release:os.release(),architecture:os.arch(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemory:os.totalmem()},runtime,dataset:{manifestSha256:await hash(path.resolve(source,'web/data/block-v1/manifest.json')),geometrySha256:await hash(path.resolve(source,'web/data/block-v1/CA/geometry/precincts-los-angeles.json'))},...result};
  await fs.mkdir('dist/benchmarks',{recursive:true});
  const artifact=`dist/benchmarks/render-${label}-${record.recordedAt.replace(/[:.]/g,'-')}.json`;
  await fs.writeFile(artifact,JSON.stringify(record,null,2)+'\n');
  console.log(JSON.stringify({label,medianMilliseconds:result.medianMilliseconds,p95Milliseconds:result.p95Milliseconds,artifact}));
 }finally{if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy()));await app.close();}await fs.rm(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
