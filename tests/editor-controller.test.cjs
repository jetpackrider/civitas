const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const core=require('../web/lib/editor-core.js');
function fixture() {
  const controls=new Map(),listeners={};
  const element=id=>{if(!controls.has(id))controls.set(id,{hidden:true,classList:{toggle(){}},addEventListener(type,fn){this[type]=fn;}});return controls.get(id);};
  const statKeys=['pop20','pop20Adjusted','pop','age_total','age_sum','inc_medhh','inc_medw'];
  const atoms=[
    {id:'a',block:'000000000000001',city:'town',stats:[10,11,12,10,300,2,100],votes:{race:[6,3,1],past:[2,6,0]}},
    {id:'b',block:'000000000000002',city:null,stats:[20,22,24,20,800,4,240],votes:{race:[8,10,2],past:[3,8,1]}},
    {id:'c',block:'000000000000003',city:'town',stats:[5,5,6,5,100,1,40],votes:{race:[3,2,0],past:[2,1,0]}},
  ].map((a,i)=>({...a,polygons:[[[[i,0],[i+1,0],[i+1,1],[i,1],[i,0]]]]}));
  const parents=[{_id:'County|1',precinct:'1',county:'County',districtId:null,bbox:[0,0,2,1],atomFile:'atoms.json.gz',pop20:30},{_id:'Other County|2',precinct:'2',county:'Other County',districtId:null,bbox:[2,0,3,1],atomFile:'other-atoms.json.gz',pop20:5}];
  let meta={count:2,mode:'by-district',name:'Test',basis:'census',names:{},locked:{}},visible=[],persisted=0;
  const sandbox={CivitasEditor:core,document:{getElementById:element,addEventListener(){}},location:{href:'https://fixture/'},URL,setTimeout,clearTimeout,console,addEventListener(type,fn){listeners[type]=fn;},Worker:class{postMessage(req){queueMicrotask(()=>this.onmessage({data:req.operation==='union'?{id:req.id,groups:{shape:req.groups.shape.flat()}}:{id:req.id,statKeys,parents:Object.fromEntries(req.parents.map(id=>[id,id==='County|1'?atoms.slice(0,2):atoms.slice(2)]))}}));}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/lib/editor-controller.js'),'utf8'),sandbox);
  const bridge={readOnly:()=>false,unit:()=> 'precinct',geography:()=> 'CA',dataset:()=> 'fixture',paintBy:()=> 'unit',meta:()=>meta,setMeta:m=>{meta=m;},setBasis:b=>{meta.basis=b;},statKeys:()=>statKeys,shapes:s=>{visible=s;},race:()=>({key:'race'}),shift:()=>({from:'past',to:'race'}),project:(x,y)=>[x,y],parse:()=>[],fetchCities:async()=>({records:[{id:'town',name:'Town',parents:parents.map(p=>p._id),bbox:[0,0,3,1],d:''}]}),redraw(){},refresh(){},zoom(){},changed(){},persist(){persisted++;}};
  const editor=sandbox.createCivitasController(bridge);editor.initialize(parents);
  return {editor,parents,get visible(){return visible;},get meta(){return meta;},get persisted(){return persisted;}};
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
