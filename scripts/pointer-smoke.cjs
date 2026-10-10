// Exercise real canvas pointer events in a disposable Electron profile.
const assert=require('node:assert/strict');
const {_electron:electron}=require('playwright');
const {prepare}=require('./test-environment.cjs');
(async()=>{
 const {profile,env,cleanup}=await prepare('pointer');let app;
 try {
  app=await electron.launch({args:['.',`--user-data-dir=${profile}`],env,timeout:60000});
  await app.context().route('https://**',r=>r.abort());
  const page=await app.firstWindow(),errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error('Renderer:',e.message);});
  await page.waitForFunction(()=>!!window.CivitasApp);
  for(const geography of ['precinct','blockgroup']) {
   console.log('Pointer integration:',geography);
   await page.selectOption('#home-geo-select',geography);await page.fill('#home-district-count','2');await page.click('#home-create-btn');
   await page.locator('#loading').waitFor({state:'hidden',timeout:120000});await page.evaluate(()=>CivitasApp.ready());
   await page.click('#paintby-unit');
   await page.evaluate(()=>{
    window.pointerFixture=CivitasApp.editor.parents.find(p=>p.county==='Alpine'&&p.pop20>100);
    window.pointerPoint=function(shape){
     const canvas=document.getElementById('map'),ctx=canvas.getContext('2d'),b=shape.bbox,path=new Path2D();
     for(const ring of shape.rings){path.moveTo(...ring[0]);for(const p of ring.slice(1))path.lineTo(...p);path.closePath();}
     ctx.save();ctx.setTransform(1,0,0,1,0,0);
     const order=Array.from({length:39},(_,i)=>i+1).sort((a,b)=>Math.abs(a-20)-Math.abs(b-20));
     try {for(const yi of order)for(const xi of order) {
      const x=b[0]+(b[2]-b[0])*xi/40,y=b[1]+(b[3]-b[1])*yi/40;
      if(!ctx.isPointInPath(path,x,y))continue;
      const screen=CivitasApp.worldToScreen(x,y),rect=canvas.getBoundingClientRect();
      if(screen[0]>rect.left+2&&screen[0]<rect.right-2&&screen[1]>rect.top+2&&screen[1]<rect.bottom-2)return {screen,world:[x,y],candidates:CivitasApp.editor.pickCandidates(x,y).map(s=>s._id||s.precinct),target:document.elementFromPoint(...screen)?.id};
     }throw Error('No visible interior point');}finally{ctx.restore();}
    };
   });
   await page.locator('#district-list .district-box').nth(0).click();
   await page.evaluate(()=>document.fonts.ready);
   await page.waitForFunction(()=>document.getElementById('stage').getAnimations().every(a=>a.playState!=='running'));
   const point=await page.evaluate(()=>pointerPoint(pointerFixture));console.log('Hit fixture:',JSON.stringify(point));
   await page.mouse.click(...point.screen);
   try {await page.waitForFunction(()=>pointerFixture.districtId===1,{},{timeout:5000});}
   catch(error){console.log('State after click:',await page.evaluate(()=>({snapshot:CivitasApp.editor.snapshot(),status:document.getElementById('editor-status').textContent,activeDistrict:document.querySelector('#district-list .active')?.textContent,tool:document.querySelector('.district-tools .active')?.id})));throw error;}
   await page.locator('#district-list .district-box').nth(0).click();
   await page.click('#tool-cursor');await page.click('#paintby-block');
   await page.waitForFunction(()=>document.getElementById('stage').getAnimations().every(a=>a.playState!=='running'));
   const blockPoint=await page.evaluate(()=>pointerPoint(pointerFixture));
   await page.mouse.click(...blockPoint.screen);
   try {await page.waitForFunction(()=>CivitasApp.editor.opened===pointerFixture,{},{timeout:30000});}
   catch(error){console.log('Open block state:',await page.evaluate(()=>({opened:CivitasApp.editor.opened?._id,status:document.getElementById('editor-status').textContent})));throw error;}
   assert.equal(await page.evaluate(()=>CivitasApp.editor.history.commands.length),1);
   await page.locator('#district-list .district-box').nth(1).click();
   await page.waitForFunction(()=>document.getElementById('stage').getAnimations().every(a=>a.playState!=='running'));
   const child=await page.evaluate(()=>{
    window.pointerChild=pointerFixture._children.filter(a=>a.pop20>0&&a.pop20<pointerFixture.pop20).sort((a,b)=>b.pop20-a.pop20)[0];
    return {...pointerPoint(pointerChild),population:pointerFixture._children.filter(a=>a.blockId===pointerChild.blockId).reduce((n,a)=>n+a.pop20,0)};
   });
   await page.mouse.click(...child.screen);
   await page.waitForFunction(()=>pointerChild.districtId===2,{},{timeout:10000});
   assert.equal(await page.evaluate(()=>CivitasApp.getStats().districts[2].pop20),child.population);
   await page.click('#block-done');await page.click('#editor-undo');
   await page.waitForFunction(()=>pointerChild.districtId===1);
   await page.waitForFunction(()=>document.getElementById('stage').getAnimations().every(a=>a.playState!=='running'));
   const anchor=await page.evaluate(()=>pointerPoint(pointerFixture)),beforeZoom=await page.evaluate(()=>CivitasApp.getView());
   await page.evaluate(()=>document.getElementById('map').addEventListener('wheel',event=>{
    const zero=CivitasApp.worldToScreen(0,0),one=CivitasApp.worldToScreen(1,1);
    window.actualZoomAnchor={screen:[event.clientX,event.clientY],world:[(event.clientX-zero[0])/(one[0]-zero[0]),(event.clientY-zero[1])/(one[1]-zero[1])]};
   },{once:true}));
   await page.mouse.move(...anchor.screen);
   for(let i=0;i<20;i++) {
    await page.mouse.wheel(0,-1000);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   }
   const zoomed=await page.evaluate(()=>({view:CivitasApp.getView(),screen:CivitasApp.worldToScreen(...actualZoomAnchor.world),anchor:actualZoomAnchor}));
   assert.equal(zoomed.view.zoom,100000);
   assert.ok(Math.abs(zoomed.view.h/zoomed.view.w-beforeZoom.h/beforeZoom.w)<1e-9);
   assert.ok(Math.hypot(zoomed.screen[0]-zoomed.anchor.screen[0],zoomed.screen[1]-zoomed.anchor.screen[1])<.01,'Wheel zoom keeps the cursor anchor: '+JSON.stringify(zoomed));
   await page.fill('#map-name-input','Pointer '+geography);await page.locator('#map-name-input').blur();
   await page.click('#nav-save-map');await page.waitForFunction(()=>document.getElementById('nav-save-map').textContent==='Saved');
   await page.click('#nav-home');
   await page.locator('#home-screen').waitFor({state:'visible'});
  }
  assert.deepEqual(errors,[]);console.log('PASS: canvas clicks paint parents, open blocks without Paint, split and undo; deep zoom preserves its cursor anchor and aspect ratio, both geographies.');
 } finally {
  if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy()));await app.close();}
  await cleanup();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
