const {test}=require('node:test');
const assert=require('node:assert/strict');
const {History,allocate,aggregate,setElectionMargin,SpatialIndex}=require('../web/lib/editor-core');
const state=n=>({assignments:{p:{district:n,overrides:{b:2}}},meta:{count:3,name:'Map'},names:{3:'Third'},locked:{3:true}});
test('undo restores splits, deleted districts and metadata; branching discards redo',()=>{
 const h=new History(),a=state(1),b=state(2);delete b.names[3];delete b.locked[3];b.meta.count=2;
 h.record('Reduce districts',a,b);assert.deepEqual(h.undo(b),a);assert.deepEqual(h.redo(a),b);
 h.undo(b);h.record('New branch',a,state(3));assert.equal(h.canRedo,false);assert.equal(h.commands.length,1);
});
test('session history is unlimited and persisted history preserves 15 steps each way',()=>{
 const h=new History();for(let i=0;i<100;i++)h.record('Paint',state(i),state(i+1));
 assert.equal(h.commands.length,100);let s=state(100);for(let i=0;i<20;i++)s=h.undo(s);
 const restored=new History(h.persistent());assert.equal(restored.cursor,15);assert.equal(restored.commands.length,30);
 for(let i=0;i<15;i++)s=restored.redo(s);assert.equal(s.assignments.p.district,95);assert.equal(restored.canRedo,false);
});
test('restored history cannot write or delete inherited sections or change section prototypes',()=>{
 const marker='civitasHistoryProbe';
 const initial=state(1),prototype=Object.getPrototypeOf(initial.names);
 const h=new History({commands:[{label:'Untrusted history',changes:[
  {section:'__proto__',key:marker,before:null,after:{evil:1}},
  {section:'constructor',key:marker,before:null,after:true},
  {section:'missing',key:marker,before:null,after:true},
  {section:'names',key:'__proto__',before:null,after:{evil:1}},
  {section:'names',key:'1',before:null,after:'First'},
 ]}],cursor:0});
 const after=h.redo(initial);
 assert.equal(Object.hasOwn(Object.prototype,marker),false);
 assert.equal(Object.hasOwn(Object,marker),false);
 assert.equal(Object.hasOwn(after,'missing'),false);
 assert.equal(Object.getPrototypeOf(after.names),prototype);
 assert.equal(Object.hasOwn(after.names,'__proto__'),true);
 assert.equal(after.names[1],'First');
 Object.defineProperty(Object.prototype,marker,{value:'Keep',configurable:true});
 try {assert.deepEqual(h.undo(after),initial);assert.equal(Object.prototype[marker],'Keep');}
 finally {delete Object.prototype[marker];}
});
test('allocation conserves integer totals, handles zero weights and has stable ties',()=>{
 assert.deepEqual(allocate(5,[1,1],['b','a']),[2,3]);assert.deepEqual(allocate(5,[0,0],['a','b']),[3,2]);
 for(let total=0;total<100;total++){const a=allocate(total,[0,3,8,2]);assert.equal(a.reduce((s,v)=>s+v,0),total);assert.ok(a.every(Number.isInteger));}
});
test('statistics derive averages and ratios from summed components',()=>{
 const r=aggregate([{dem:1,rep:3,age_sum:100,age_total:10,inc_medw:10000,inc_medhh:1},{dem:5,rep:1,age_sum:100,age_total:2,inc_medw:60000,inc_medhh:3}],['dem','rep','age_sum','age_total','inc_medw','inc_medhh']);
 assert.equal(r.margin,.2);assert.equal(r.age_avg,200/12);assert.equal(r.inc_med,17500);
});
test('split election margins preserve Other candidates and no-vote records',()=>{
 assert.deepEqual(setElectionMargin({dem:10,rep:5,other:20}),{dem:10,rep:5,other:20,lead:'x',margin:1/3});
 assert.equal(aggregate([{dem:5,rep:20,other:10}],['dem','rep','other']).margin,-1/3);
 assert.equal(setElectionMargin({dem:0,rep:0,other:0}).margin,null);
});
test('spatial index includes large shapes and filters empty bounding boxes',()=>{
 const a={bbox:[0,0,1,1]},b={bbox:[-10000,-10000,10000,10000]};
 const index=new SpatialIndex([a,b],1);assert.deepEqual(index.at(.5,.5),[a,b]);assert.deepEqual(index.at(2,2),[b]);
 assert.deepEqual(index.range([2,2,3,3]),[b]);
 assert.deepEqual(new Set(index.range([0,0,3,3])),new Set([a,b]));
});

 test('display omits subpixel fragments without modifying exact geometry',()=>{
  const {displayRing}=require('../web/lib/editor-core.js');
  const tiny=[[1,1],[1.001,1],[1.001,1.001],[1,1.001],[1,1]],before=JSON.stringify(tiny);
  assert.equal(displayRing(tiny,2),false);assert.equal(JSON.stringify(tiny),before);
  assert.equal(displayRing(tiny,0,10),false);assert.equal(displayRing(tiny,0,1000),true);
  const small=[[0,0],[.5,0],[.5,.5],[0,.5],[0,0]];
  assert.equal(displayRing(small,2),false);assert.equal(displayRing(small,0),true);
 });
