// Paint real Los Angeles cities in hidden, isolated app instances and time each stage.
// Usage: node scripts/city-benchmark.cjs [current|baseline|both] [baseline-commit]
// "baseline" serves the worker, controller and page from the given commit (default b73e248)
// on the same data; nothing in the working tree, the user's profile or running app changes.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {_electron:electron}=require('playwright');
const {hash}=require('./data-integrity.cjs');
const root=path.resolve(__dirname,'..');
const CITIES=['Lancaster','Palmdale'],IDLE_TIMEOUT=Number(process.env.CITY_BENCHMARK_TIMEOUT_MS||120000);
if(!Number.isFinite(IDLE_TIMEOUT)||IDLE_TIMEOUT<=0)throw Error('CITY_BENCHMARK_TIMEOUT_MS must be positive');
const BASELINE_FILES=['web/lib/block-worker.js','web/lib/editor-controller.js','web/index.html','web/lib/editor-core.js'];
const SOURCE=[...BASELINE_FILES,'web/lib/geometry-union.js','web/vendor/polygon-clipping.umd.js'];
const DATA=['atoms/los-angeles.json.gz','CA/cities.json','CA-BG/cities.json','CA/geometry/precincts-los-angeles.json','CA-BG/geometry/precincts-los-angeles.json'];

async function prepare(variant,commit) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'civitas-city-'));
  try {
  const web=path.join(directory,'web');
  for(const entry of await fs.readdir(path.join(root,'web'),{withFileTypes:true}))if(entry.name!=='data')await fs.cp(path.join(root,'web',entry.name),path.join(web,entry.name),{recursive:true});
  await fs.cp(path.join(root,'tests/fixtures/block-v1'),path.join(web,'data/block-v1'),{recursive:true});
  for(const file of DATA){await fs.mkdir(path.dirname(path.join(web,'data/block-v1',file)),{recursive:true});await fs.copyFile(path.join(root,'web/data/block-v1',file),path.join(web,'data/block-v1',file));}
  if(variant==='baseline')for(const file of BASELINE_FILES) {
    const shown=spawnSync('git',['-C',root,'show',`${commit}:${file}`],{maxBuffer:1<<28});
    if(shown.status!==0)throw Error(`git show ${commit}:${file} failed: ${shown.stderr}`);
    await fs.writeFile(path.join(directory,file),shown.stdout);
  }
  const sourceHashes=Object.fromEntries(await Promise.all(SOURCE.map(async f=>[f,await hash(path.join(directory,f))])));
  const datasetHashes=Object.fromEntries(await Promise.all(['manifest.json','CA/geometry/manifest.json','CA-BG/geometry/manifest.json',...DATA].map(async f=>[f,await hash(path.join(web,'data/block-v1',f))])));
  return {directory,web,sourceHashes,datasetHashes};
  }catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}
}

// Runs in the renderer: instruments worker traffic and error notices, then paints.
async function scenario({geoDir,cities,idleTimeout}) {
  const B={jobs:new Map(),notices:[]},hooked=new WeakSet(),atomPolygons=new WeakSet();
  const original=Worker.prototype.postMessage;
  const classify=msg=>{
    if(msg.operation!=='union')return 'load';
    if(!msg.groups.shape)return 'parent'; // current code batches parent merges by signature
    if(msg.supersede)return 'district';
    // The baseline sends parent merges and district outlines in the same form.
    for(const p of CivitasApp.editor.parents)for(const a of p._children||[])atomPolygons.add(a._polygons);
    return atomPolygons.has(msg.groups.shape[0])?'parent':'district';
  };
  Worker.prototype.postMessage=function(msg,...rest) {
    if(!hooked.has(this)){hooked.add(this);this.addEventListener('message',({data})=>{const job=B.jobs.get(data.id);if(!job||job.done)return;job.done=performance.now();job.cancelled=!!data.cancelled;job.stats=data.stats||null;
      const errors=data.error?[data.error]:Object.values(data.errors||{});job.errors=errors;
      if(job.kind==='district'&&data.groups?.shape)job.rings=data.groups.shape.reduce((n,poly)=>n+poly.length,0);});}
    if(msg&&(msg.operation||msg.url)&&!msg.profile)msg={...msg,profile:true}; // opt the worker into per-phase timings
    B.jobs.set(msg.id,{id:msg.id,kind:classify(msg),groups:msg.groups?Object.keys(msg.groups).length:0,sent:performance.now()});
    return original.call(this,msg,...rest);
  };
  const status=document.getElementById('editor-status');
  new MutationObserver(()=>{if(status.classList.contains('error')&&!status.hidden)B.notices.push(status.textContent);}).observe(status,{attributes:true,childList:true,characterData:true,subtree:true});
  const outstanding=()=>[...B.jobs.values()].filter(j=>!j.done).length;
  async function idle() {
    const start=performance.now();let quietSince=null;
    while(performance.now()-start<idleTimeout) {
      const busy=outstanding()||CivitasApp.editor.busy||CivitasApp.editor.mergesPending;
      if(busy)quietSince=null;else if(quietSince===null)quietSince=performance.now();else if(performance.now()-quietSince>750)return true;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    return false;
  }
  const e=CivitasApp.editor;
  const doc=await (await fetch(geoDir+'geometry/precincts-los-angeles.json')).json();
  const records=doc.records.map(r=>({...r,_id:r.county+'|'+r.precinct,rings:r.d.split(' Z').filter(s=>s.trim()).map(s=>s.trim().replace(/^M\s*/,'').split(/\s+/).map(p=>p.split(',').map(Number))),paths:[null,null,null],fill:'#e3e5e9',districtId:null,bboxArea:(r.bbox[2]-r.bbox[0])*(r.bbox[3]-r.bbox[1]),dem:0,rep:0,other:0,margin:null}));
  e.initialize(records);await e.ready;await idle();
  const state=()=>({assignments:JSON.stringify(e.snapshot().assignments),totals:JSON.stringify(Object.fromEntries(Object.entries(CivitasApp.getStats().districts).map(([k,v])=>[k,v&&v.pop20]))),cursor:e.history.cursor});
  async function paint(name,district,label=name) {
    const city=e.cities.find(c=>c.name===name);if(!city)throw Error('No city '+name);
    const first=Math.max(0,...B.jobs.keys())+1,noticeStart=B.notices.length,t0=performance.now();
    await e.paintCity(city,'paint',district,{});
    const painted=performance.now(),settled=await idle();
    const jobs=[...B.jobs.values()].filter(j=>j.id>=first),end=kind=>Math.max(0,...jobs.filter(j=>j.kind===kind&&!j.cancelled&&j.done).map(j=>j.done));
    const loadEnd=end('load')||t0,atoms=city.parents.flatMap(id=>e.parents.find(p=>p._id===id)?._children||[]).filter(a=>a.cityId===city.id);
    const district_=jobs.filter(j=>j.kind==='district'),finalJob=district_.filter(j=>!j.cancelled&&j.done).sort((a,b)=>b.done-a.done)[0];
    const groupStats=[];for(const j of jobs)if(j.kind!=='load'&&j.stats&&!j.cancelled)for(const [key,s] of Object.entries(j.stats))groupStats.push({kind:j.kind,key:key.length>72?key.slice(0,72)+'…':key,...s});
    const sum=f=>Math.round(groupStats.reduce((n,g)=>n+(g[f]||0),0));
    return {label,settled,atoms:atoms.length,vertices:atoms.reduce((n,a)=>n+a._polygons.flat(2).length,0),
      loadMs:Math.round(loadEnd-t0),assignMs:Math.round(painted-loadEnd),
      parentMergeMs:end('parent')?Math.round(end('parent')-painted):0,finalDistrictMergeMs:end('district')?Math.round(end('district')-painted):0,
      totalMs:Math.round(Math.max(painted,...jobs.filter(j=>j.done).map(j=>j.done))-t0),
      parentJobs:jobs.filter(j=>j.kind==='parent').length,parentGroups:jobs.filter(j=>j.kind==='parent').reduce((n,j)=>n+j.groups,0),
      districtJobsRun:district_.filter(j=>!j.cancelled).length,districtJobsCancelled:district_.filter(j=>j.cancelled).length,
      finalOutlineRings:finalJob?.rings??null,finalOutlineError:finalJob?.errors?.[0]??null,
      phaseTotals:{groups:groupStats.length,ms:sum('ms'),snapMs:sum('snapMs'),unionMs:sum('unionMs'),clipMs:sum('clipMs'),diffMs:sum('diffMs'),guardMs:sum('guardMs'),vertices:groupStats.reduce((n,g)=>n+(g.vertices||0),0)},
      topGroups:groupStats.sort((a,b)=>b.ms-a.ms).slice(0,8).map(({key,kind,ms,vertices,method,snapMs,unionMs,clipMs,diffMs,guardMs,attempts})=>({key,kind,ms:Math.round(ms),vertices,method,snapMs:Math.round(snapMs||0),unionMs:Math.round(unionMs||0),clipMs:Math.round(clipMs||0),diffMs:Math.round(diffMs||0),guardMs:Math.round(guardMs||0),attempts})),
      loadPhases:jobs.filter(j=>j.kind==='load'&&j.stats&&!j.cancelled).map(j=>j.stats),
      workerErrors:jobs.flatMap(j=>j.errors||[]).map(m=>m.slice(0,160)),notices:B.notices.slice(noticeStart).map(m=>m.slice(0,200)),
      unionStats:e.unionStats||null};
  }
  const runs=[];
  for(const [i,name] of cities.entries()){const result=await paint(name,i+1);runs.push(result);console.log('City benchmark: '+JSON.stringify(result));if(!result.settled)return {parents:records.length,runs,undo:null,timedOut:true};}
  // Repaint, undo and redo must restore assignments, district totals and the history cursor exactly.
  const beforeRepaint=state();
  runs.push(await paint(cities[0],2,cities[0]+' repaint'));
  const afterRepaint=state();
  await e.undoRedo('undo');await idle();const undone=state();
  await e.undoRedo('redo');await idle();const redone=state();
  const undo={undoMatches:JSON.stringify(undone)===JSON.stringify(beforeRepaint),redoMatches:JSON.stringify(redone)===JSON.stringify(afterRepaint),repaintChanged:beforeRepaint.assignments!==afterRepaint.assignments};
  return {parents:records.length,runs,undo};
}

async function run(variant,geography,commit) {
  const {directory,web,sourceHashes,datasetHashes}=await prepare(variant,commit),profile=path.join(directory,'profile');let app;const pageErrors=[];
  try {
    const env={...process.env,CIVITAS_TEST_HIDE_WINDOW:'1',CIVITAS_TEST_WEB_ROOT:web};delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({args:[root,`--user-data-dir=${profile}`],env,timeout:60000});
    await app.context().route('https://**',r=>r.abort());
    const page=await app.firstWindow();page.on('dialog',d=>d.dismiss().catch(()=>{}));page.on('console',m=>{if(m.text().startsWith('City benchmark:'))console.log(variant,geography,m.text());});page.on('pageerror',e=>pageErrors.push(e.message));
    await page.waitForFunction(()=>!!window.CivitasApp);
    await page.selectOption('#home-geo-select',geography);await page.fill('#home-district-count','3');
    await page.locator('#home-create-btn').dispatchEvent('click');await page.waitForFunction(()=>!document.getElementById('app-view').hidden);
    await page.evaluate(()=>CivitasApp.ready());
    const scenarioResult=page.evaluate(scenario,{geoDir:'data/block-v1/'+(geography==='blockgroup'?'CA-BG':'CA')+'/',cities:CITIES,idleTimeout:IDLE_TIMEOUT});
    let timeout;
    const result=await Promise.race([scenarioResult,new Promise(resolve=>{timeout=setTimeout(()=>resolve({parents:null,runs:[],undo:null,timedOut:true,error:'Renderer did not complete the city scenario within its wall-clock limit'}),IDLE_TIMEOUT*2+60000);})]).finally(()=>clearTimeout(timeout));
    return {variant,geography,...result,pageErrors,sourceHashes,datasetHashes};
  }finally{
    if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{});}
    await fs.rm(directory,{recursive:true,force:true});
  }
}

(async()=>{
  const mode=process.argv[2]||'both',commit=process.argv[3]||'b73e248';
  if(!['current','baseline','both'].includes(mode)||!/^[0-9a-f]{7,40}$/.test(commit))throw Error('Usage: city-benchmark.cjs [current|baseline|both] [commit]');
  const variants=mode==='both'?['baseline','current']:[mode],results=[];
  for(const variant of variants)for(const geography of ['precinct','blockgroup']) {
    const result=await run(variant,geography,commit);results.push(result);
    for(const r of result.runs)console.log(JSON.stringify({variant,geography,...r,unionStats:undefined}));
    console.log(JSON.stringify({variant,geography,undo:result.undo,pageErrors:result.pageErrors}));
  }
  const revision=spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  const record={schemaVersion:1,recordedAt:new Date().toISOString(),commit:revision,baselineCommit:commit,dirty:spawnSync('git',['-C',root,'status','--porcelain','--',...SOURCE],{encoding:'utf8'}).stdout.trim().split('\n').filter(Boolean),
    hardware:{platform:os.platform(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemory:os.totalmem()},
    results};
  await fs.mkdir(path.join(root,'dist/benchmarks'),{recursive:true});
  const artifact=path.join(root,'dist/benchmarks',`city-${mode}-${record.recordedAt.replace(/[:.]/g,'-')}.json`);
  await fs.writeFile(artifact,JSON.stringify(record,null,2)+'\n');console.log('Wrote',path.relative(root,artifact));
  if(results.some(r=>r.variant==='current'&&(r.timedOut||r.pageErrors.length||!r.undo?.undoMatches||!r.undo?.redoMatches||!r.undo?.repaintChanged||r.runs.some(p=>!p.settled||p.workerErrors.length||p.notices.length||p.finalOutlineError))))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
