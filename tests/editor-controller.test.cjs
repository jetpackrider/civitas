const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const core=require('../web/lib/editor-core.js');
// The mock worker unions by concatenation; options.union may replace its reply.
function fixture(options={}) {
  let worker,hold=!!options.hold;const unions=[],held=[],geometryChanges=[];
  const union=options.union||(req=>({id:req.id,groups:Object.fromEntries(Object.entries(req.groups).map(([k,v])=>[k,(Array.isArray(v)?v:v.polygons).flat()])),errors:{},methods:Object.fromEntries(Object.entries(req.groups).map(([k,v])=>[k,Array.isArray(v)?'union':'difference']))}));
  const controls=new Map(),listeners={};
  const element=id=>{if(!controls.has(id))controls.set(id,{hidden:true,classList:{toggle(){}},addEventListener(type,fn){this[type]=fn;}});return controls.get(id);};
  const statKeys=['pop20','pop20Adjusted','pop','age_total','age_sum','inc_medhh','inc_medw'];
  const atoms=[
    {id:'a',block:'000000000000001',city:'town',stats:[10,11,12,10,300,2,100],votes:{race:[6,3,1],past:[2,6,0]}},
    {id:'b',block:'000000000000002',city:null,stats:[20,22,24,20,800,4,240],votes:{race:[8,10,2],past:[3,8,1]}},
    {id:'c',block:'000000000000003',city:'town',stats:[5,5,6,5,100,1,40],votes:{race:[3,2,0],past:[2,1,0]}},
  ].map((a,i)=>({...a,polygons:[[[[i,0],[i+1,0],[i+1,1],[i,1],[i,0]]]]}));
  const parents=[{_id:'County|1',precinct:'1',county:'County',districtId:null,bbox:[0,0,2,1],atomFile:'atoms.json.gz',pop20:30},{_id:'Other County|2',precinct:'2',county:'Other County',districtId:null,bbox:[2,0,3,1],atomFile:'other-atoms.json.gz',pop20:5}];
  const parentAtoms={'County|1':atoms.slice(0,2),'Other County|2':atoms.slice(2)};
  // options.extra adds parents that each hold one city atom and one atom outside the city.
  for(let i=0;i<(options.extra||0);i++) {
    const id='Extra|'+i,y=2+i;
    parents.push({_id:id,precinct:'x'+i,county:'Extra',districtId:null,bbox:[0,y,2,y+1],atomFile:'extra.json.gz',pop20:2});
    parentAtoms[id]=[0,1].map(j=>({id:'x'+i+'-'+j,block:String(100000000000000+i*2+j),city:j?null:'town',stats:[1,1,1,1,30,1,10],votes:{},polygons:[[[[j,y],[j+1,y],[j+1,y+1],[j,y+1],[j,y]]]]}));
  }
  if(options.huge)parentAtoms['County|1'][0]={...atoms[0],polygons:[[Array.from({length:150002},(_,i)=>i===150001?[0,0]:[Math.cos(i/150001*2*Math.PI),Math.sin(i/150001*2*Math.PI)])]]};
  // options.record gives the first parent a geometry record and its unassigned atom more
  // vertices than the city atom, so a city paint leaves it the dominant group.
  if(options.record) {
    parents[0].rings=[[[0,0],[2,0],[2,1],[0,1],[0,0]]];
    parentAtoms['County|1'][1]={...atoms[1],polygons:[[[[1,0],[2,0],[2,1],[1,1],[1,0.8],[1,0.6],[1,0.4],[1,0.2],[1,0]]]]};
  }
  let meta={count:2,mode:'by-district',name:'Test',basis:'census',names:{},locked:{}},visible=[],persisted=0;
  const sandbox={CivitasEditor:core,document:{getElementById:element,addEventListener(){}},location:{href:'https://fixture/'},URL,setTimeout,clearTimeout,console,addEventListener(type,fn){listeners[type]=fn;},Worker:class{constructor(){worker=this;}postMessage(req){
    if(req.operation==='union'){unions.push(req);const reply=()=>this.onmessage({data:union(req)});hold?held.push(reply):queueMicrotask(reply);return;}
    queueMicrotask(()=>this.onmessage({data:{id:req.id,statKeys,parents:Object.fromEntries(req.parents.map(id=>[id,parentAtoms[id]]))}}));}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/lib/editor-controller.js'),'utf8'),sandbox);
  const bridge={readOnly:()=>false,unit:()=> 'precinct',geography:()=> 'CA',dataset:()=> 'fixture',paintBy:()=> 'unit',meta:()=>meta,setMeta:m=>{meta=m;},setBasis:b=>{meta.basis=b;},statKeys:()=>statKeys,shapes:s=>{visible=s;},race:()=>({key:'race'}),shift:()=>({from:'past',to:'race'}),project:(x,y)=>[x,y],parse:()=>[],fetchCities:async()=>({records:[{id:'town',name:'Town',parents:parents.map(p=>p._id),bbox:[0,0,3,1],d:''}]}),redraw(){},refresh(){},geometryChanged(){if(options.throwOnChange)throw Error('draw failed');geometryChanges.push(visible.filter(s=>s.displayRings).map(s=>s._signature));},zoom(){},changed(){},persist(){persisted++;}};
  const editor=sandbox.createCivitasController(bridge);editor.initialize(parents);
  return {editor,parents,unions,held,geometryChanges,status:element('editor-status'),release(){hold=false;held.splice(0).forEach(reply=>reply());},get visible(){return visible;},get meta(){return meta;},get persisted(){return persisted;}};
}
test('opening blocks is view-only; split, live totals, close, undo, redo and remerge',async()=>{
  const f=fixture(),e=f.editor,p=f.parents[0];
  e.apply(p,'paint','unit',1,{});e.endStroke();
  await e.openBlocks(p);
  assert.equal(e.history.commands.length,1);
  const a=p._children[0];e.apply(a,'paint','block',2,{});e.endStroke();
  assert.equal(f.visible.filter(s=>s._parent===p).length,2);
  assert.equal(f.visible.find(s=>s.districtId===2).pop20,10);
  assert.equal(f.visible.find(s=>s.districtId===2).shAd,2);
  e.closeBlocks();assert.equal(f.visible.filter(s=>s._parent===p).length,2);
  await e.undoRedo('undo');assert.equal(p._children.every(a=>a.districtId===1),true);
  await e.undoRedo('redo');assert.equal(p._children[0].districtId,2);
  const remaining=f.visible.find(s=>s._parent===p&&s.districtId===1);
  e.apply(remaining,'paint','unit',2,{});e.endStroke();
  assert.ok(f.visible.includes(p));assert.equal(p.districtId,2);
  assert.equal(e.history.commands.length,3);
});
test('initialization rebuilds picking when a loader populated the previously empty view',()=>{
  const f=fixture(),e=f.editor;e.initialize([]);
  const loaded=f.visible;loaded.push(...f.parents);
  e.initialize(loaded);
  assert.equal(e.pickCandidates(.5,.5).includes(f.parents[0]),true);
});
test('city paint and erase include every city piece, preserve exterior and respect locks',async()=>{
  const f=fixture(),e=f.editor;await e.ready;
  for(const p of f.parents)e.apply(p,'paint','unit',1,{});e.endStroke();
  await e.paintCity(e.cities[0],'paint',2,{});
  assert.deepEqual(f.parents.flatMap(p=>p._children.map(a=>a.districtId)),[2,1,2]);
  const cityTotal=f.visible.filter(s=>s.districtId===2).reduce((n,s)=>n+s.pop20,0);assert.equal(cityTotal,15);
  await e.paintCity(e.cities[0],'eraser',2,{2:true});
  assert.deepEqual(f.parents.flatMap(p=>p._children.map(a=>a.districtId)),[2,1,2]);
  await e.paintCity(e.cities[0],'eraser',2,{});
  assert.deepEqual(f.parents.flatMap(p=>p._children.map(a=>a.districtId)),[null,1,null]);
  await e.undoRedo('undo');assert.deepEqual(f.parents.flatMap(p=>p._children.map(a=>a.districtId)),[2,1,2]);
});
test('district deletion and metadata restore assignments, names, locks, basis and redo branching',async()=>{
  const f=fixture(),e=f.editor;await e.openBlocks(f.parents[0]);
  e.apply(f.parents[0]._children[0],'paint','block',2,{});e.endStroke();
  e.metadataChanged('Metadata',()=>Object.assign(f.meta,{basis:'adjusted',names:{2:'Name'},locked:{2:true}}));
  e.metadataChanged('Delete district',()=>{e.reduceCount(1);f.meta.count=1;});
  assert.equal(f.parents[0]._children[0].districtId,null);
  await e.undoRedo('undo');assert.equal(f.meta.count,2);assert.equal(f.parents[0]._children[0].districtId,2);
  await e.undoRedo('undo');assert.equal(f.meta.basis,'census');assert.equal(f.meta.names[2],undefined);
  e.metadataChanged('Rename',()=>{f.meta.name='New';});assert.equal(e.history.canRedo,false);
});
test('version 2 restore preserves split assignments and history; invalid restore is atomic',async()=>{
  const f=fixture(),e=f.editor;await e.openBlocks(f.parents[0]);
  e.apply(f.parents[0]._children[0],'paint','block',2,{});e.endStroke();
  const saved={...e.exportState(),count:2};
  const next=fixture();await next.editor.restore(saved,'Saved');
  assert.equal(next.parents[0]._children[0].districtId,2);assert.equal(next.editor.history.canUndo,true);
  const before=core.copy(next.editor.snapshot());
  await assert.rejects(next.editor.restore({...saved,unitAssignments:{'County|1':{district:1},'Other County|2':{district:999}}},'Bad'),/Invalid district/);
  assert.deepEqual(core.copy(next.editor.snapshot()),before);
  await assert.rejects(next.editor.restore({...saved,dataset:'future'},'Bad'),/unavailable/);
});
test('restores reject excessive or malformed metadata and inherited unit IDs atomically',async()=>{
 const f=fixture(),e=f.editor;
 await e.restore({version:2,dataset:'fixture',count:2,names:{1:'First'},locked:{1:false,2:true}},'Saved');
 const before=core.copy(e.snapshot());
 const invalid=[
  {names:{3:'Outside district count'}},{names:{'01':'Noncanonical'}},
  {names:{1:'x'.repeat(41)}},{names:{1:{text:'Nested'}}},{names:['First']},
  {names:Object.fromEntries(Array.from({length:1001},(_,i)=>[i+1,'N']))},
  {locked:{1:1}},{locked:{1:{value:true}}},{locked:{0:true}},
  {names:JSON.parse('{"__proto__":{"evil":1}}')},
  {unitAssignments:JSON.parse('{"__proto__":{"district":1}}')},
  {assignments:{constructor:1}},
 ];
 for(const values of invalid) {
  await assert.rejects(e.restore({version:2,dataset:'fixture',count:2,...values},'Bad'),/Invalid district|geography could not be matched/);
  assert.deepEqual(core.copy(e.snapshot()),before);
 }
});
test('draft/shared restore cannot pollute prototypes through persisted redo',async()=>{
 const f=fixture(),e=f.editor;
 await e.restore({version:2,dataset:'fixture',count:2,history:{cursor:0,commands:[{label:'Injected',changes:[
  {section:'__proto__',key:'civitasHistoryProbe',before:null,after:true},
  {section:'names',key:'1',before:null,after:'First'},
 ]}]}},'Shared');
 await e.undoRedo('redo');
 assert.equal(Object.hasOwn(Object.prototype,'civitasHistoryProbe'),false);
 assert.equal(f.meta.names[1],'First');
 await e.undoRedo('undo');assert.deepEqual(core.copy(f.meta.names),{});
});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function paintTown(f) {
  const e=f.editor;await e.ready;
  for(const p of f.parents)e.apply(p,'paint','unit',1,{});e.endStroke();
  await e.paintCity(e.cities[0],'paint',2,{});await tick();
}
test('parent merges from one city paint are batched and display-only',async()=>{
  const f=fixture({hold:true}),e=f.editor;await paintTown(f);
  assert.equal(f.unions.length,1);
  assert.deepEqual(Object.keys(f.unions[0].groups).sort(),['a','b']);
  assert.equal(e.mergesPending,2);
  const split=f.visible.filter(s=>s._signature),exact=split.map(s=>[s.rings,s._polygons]),totals=f.visible.map(s=>s.pop20);
  const done=e.mergesSettled();f.release();await done;
  assert.equal(e.mergesPending,0);assert.equal(f.geometryChanges.length,1);
  // Merged outlines only feed drawing; exact atom rings stay for picking, outlines and export.
  for(const [i,s] of split.entries()){assert.ok(s.displayRings);assert.equal(s.rings,exact[i][0]);assert.equal(s._polygons,exact[i][1]);}
  assert.deepEqual(f.visible.map(s=>s.pop20),totals);assert.equal(e.history.commands.length,2);
});
test('a batch larger than the 512-entry outline cache applies every result and settles once',async()=>{
  const f=fixture({extra:300}),e=f.editor;await paintTown(f);await e.mergesSettled();
  const groups=f.unions.reduce((n,u)=>n+Object.keys(u.groups).length,0);
  assert.ok(groups>512,'groups '+groups);assert.equal(f.unions.length,1);
  assert.equal(e.mergesPending,0);
  assert.equal(f.visible.filter(s=>s._signature&&!s.displayRings).length,0);
  assert.equal(f.status.textContent===undefined||!/could not merge/.test(f.status.textContent),true);
});
test('merge replies from a previous map are ignored, settle once, and a repaint merges again',async()=>{
  const f=fixture({hold:true}),e=f.editor;await paintTown(f);
  const old=f.visible.filter(s=>s._signature);
  e.initialize(f.parents);f.release();await e.mergesSettled();
  assert.equal(e.mergesPending,0);assert.equal(f.geometryChanges.length,0);assert.ok(old.every(s=>!s.displayRings));
  await paintTown(f);await e.mergesSettled();
  assert.equal(e.mergesPending,0);assert.ok(f.visible.filter(s=>s._signature).every(s=>s.displayRings));
});
test('a failing redraw after a merge cannot decrement the pending count twice',async()=>{
  const f=fixture({throwOnChange:true}),e=f.editor;await paintTown(f);await e.mergesSettled();await tick();
  assert.equal(e.mergesPending,0);
  await e.paintCity(e.cities[0],'paint',1,{});await tick();await e.mergesSettled();
  assert.equal(e.mergesPending,0);
});
test('a failed parent merge is reported by name and other parents still merge',async()=>{
  const f=fixture({union:req=>({id:req.id,groups:req.groups.b?{b:req.groups.b.flat()}:{},errors:req.groups.a?{a:'Could not merge outline (grid 1e-7: boom)'}:{}})}),e=f.editor;
  await paintTown(f);await e.mergesSettled();
  assert.match(f.status.textContent,/Block outline could not merge for 1: Could not merge outline/);
  assert.deepEqual(Array.from(f.geometryChanges[0]),['b']);
});
test('very large groups receive a complete merge and are not repeatedly queued',async()=>{
  const f=fixture({huge:true}),e=f.editor;await paintTown(f);await e.mergesSettled();
  assert.ok(f.unions.some(u=>Object.hasOwn(u.groups,'a')));
  const big=f.visible.find(s=>s._signature==='a');assert.ok(big.displayRings);
  const requests=f.unions.length;e.sync();await tick();assert.equal(f.unions.length,requests,'a merged group is not re-queued on every sync');
});
test('the dominant group of a parent record merges as a parent-minus-rest difference',async()=>{
  const f=fixture({record:true}),e=f.editor;await paintTown(f);await e.mergesSettled();
  const message=f.unions.find(u=>u.groups.b&&u.groups.b.difference);
  assert.ok(message,'the dominant remainder carries a difference spec');
  // Sandbox-created arrays do not deep-compare against outer literals, so compare by identity.
  assert.equal(message.groups.b.polygons.length,1);
  assert.equal(message.groups.b.polygons[0],f.parents[0]._children[1]._polygons);
  assert.equal(message.groups.b.difference.subject,f.parents[0].rings);
  assert.equal(message.groups.b.difference.clips.length,1);
  assert.equal(message.groups.b.difference.clips[0][0],f.parents[0]._children[0]._polygons);
  assert.equal(Array.isArray(f.unions.find(u=>u.groups.a).groups.a),true,'the smaller group stays a plain union');
  assert.equal(e.unionStats.differenced,1);assert.equal(e.unionStats.fallbacks,0);
  assert.ok(f.visible.find(s=>s._signature==='b').displayRings);
});
test('district outline requests carry a supersession key and cancelled replies resolve null',async()=>{
  const f=fixture({union:req=>req.supersede==='district:1'?{id:req.id,cancelled:true}:{id:req.id,groups:{shape:req.groups.shape.flat()},errors:{}}}),e=f.editor;
  assert.equal(await e.unionGeometry([[[[0,0],[1,0],[1,1],[0,0]]]],1),null);
  assert.equal(f.unions[0].supersede,'district:1');
  assert.equal((await e.unionGeometry([[[[0,0],[1,0],[1,1],[0,0]]]],2)).length,1);
  assert.equal(e.unionStats.cancelled,1);
});
