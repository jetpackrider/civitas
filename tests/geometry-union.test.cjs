const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const polygonClipping=require('../web/vendor/polygon-clipping.umd.js');
const U=require('../web/lib/geometry-union.js');
const fixture=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/union',name+'.json'),'utf8'));
// The union used before this fix: every chunk of 100 re-sweeps the whole accumulated prefix.
const chunked=polys=>{let r=[];for(let i=0;i<polys.length;i+=100)r=polygonClipping.union(r,...polys.slice(i,i+100));return r;};
const square=(x,y,w=1,h=w)=>[[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]];
const holes=geom=>geom.reduce((n,poly)=>n+poly.length-1,0);
const rawArea=geoms=>geoms.reduce((n,g)=>n+U.geomArea(g),0);
const rawPerimeter=geoms=>geoms.reduce((n,g)=>n+U.geomPerimeter(g),0);
const inRing=(x,y,r)=>{let c=false;for(let i=0,j=r.length-1;i<r.length;j=i++)if((r[i][1]>y)!==(r[j][1]>y)&&x<(r[j][0]-r[i][0])*(y-r[i][1])/(r[j][1]-r[i][1])+r[i][0])c=!c;return c;};
const covers=(geom,[x,y])=>geom.some(poly=>inRing(x,y,poly[0])&&!poly.slice(1).some(h=>inRing(x,y,h)));
const at100000x=1e-5; // world units per CSS pixel at the maximum zoom (one world unit is about one pixel at 1x)

// Real Los Angeles inputs captured from data revision manifest 5c8c6ce0…, atoms 0b7fcf18… (before repair).
for(const [name,baseline] of [
  ['ca-bg-lancaster-060379009012',/Unable to find segment/],
  ['ca-bg-palmdale-060379104041',/Unable to find segment/],
  ['ca-lancaster-district-pair',/Unable to find segment/],
  ['la-unmapped-step-output-ring',/Unable to complete output ring/],
  ['ca-bg-palmdale-060379102102',null],
]) test(`real reproducer ${name} merges on the 1e-7 grid without changing its input`,()=>{
  const {polygons}=fixture(name),before=JSON.stringify(polygons);
  if(baseline)assert.throws(()=>chunked(polygons),baseline,'baseline union should fail on this input');
  const result=U.robustUnion(polygons);
  assert.equal(JSON.stringify(polygons),before,'caller input is not modified');
  assert.equal(result.grid,1e-7);
  assert.ok(result.polygons.length>0);
  // The largest vertex move is invisible at the 100,000x maximum zoom.
  assert.ok(result.grid*Math.SQRT1_2<at100000x/100);
  assert.ok(result.outputArea<=rawArea(polygons)+result.grid*Math.SQRT1_2*rawPerimeter(polygons));
  // Already-snapped input gives the same outline.
  assert.equal(JSON.stringify(U.robustUnion(U.snapPolygons(polygons,1e-7)).polygons),JSON.stringify(result.polygons));
});

test('a failed reduction step is re-snapped and retried instead of failing the outline',()=>{
  const {polygons}=fixture('la-unmapped-step-output-ring');
  assert.throws(()=>polygonClipping.union(...polygons),/Unable to complete output ring/);
  const collapsed=[],merged=U.balancedUnion(polygons,8,1e-7,collapsed);
  assert.ok(merged.length>0);assert.ok(collapsed.every(c=>c.width<=U.QUANTUM));
});

test('every populated fragment of the real Los Angeles strip survives the union',()=>{
  const strip=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/geometry/los-angeles-strip.json'),'utf8'));
  const p=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/block-v1/CA/geometry/manifest.json'),'utf8')).projection;
  const D=Math.PI/180,n=(Math.sin(p.lat1*D)+Math.sin(p.lat2*D))/2,C=Math.cos(p.lat1*D)**2+2*n*Math.sin(p.lat1*D),rho0=Math.sqrt(C-2*n*Math.sin(p.lat0*D))/n,lam0=p.lon0*D;
  const project=pt=>{const rho=Math.sqrt(C-2*n*Math.sin(pt[1]*D))/n,th=n*(pt[0]*D-lam0);return [(rho*Math.sin(th)-p.xmin)*p.scale,(p.ymax-(rho0-rho*Math.cos(th)))*p.scale];};
  const atoms=strip.atoms.map(a=>({...a,world:a.polygons.map(poly=>poly.map(ring=>ring.map(project)))}));
  const result=U.robustUnion(atoms.map(a=>a.world));
  assert.equal(result.grid,1e-7);assert.equal(result.droppedRings,0);
  for(const a of atoms.filter(a=>a.required))for(const poly of a.world){
    const probe=U.interiorPoint(poly);
    assert.ok(covers(result.polygons,probe.point),a.id+' is covered');
  }
  const assigned=atoms.find(a=>a.id!=='060375526013004:9d75dd1cbe8f8e6a');
  const remainder=atoms.filter(a=>a!==assigned);
  const difference=U.robustDifference(result.polygons.flat(),[[assigned.world]],remainder.map(a=>a.world));
  for(const a of remainder.filter(a=>a.required))for(const poly of a.world)
    assert.ok(covers(difference.polygons,U.interiorPoint(poly).point),a.id+' survives differencing');
  // A grid coarse enough (about 0.57 m) to collapse a fragment is rejected rather than losing it.
  assert.throws(()=>U.robustUnion(atoms.map(a=>a.world),{grids:[1e-3]}),/collapse|missing/);
});

test('a narrow populated piece and a narrow real hole are preserved, or the grid is rejected',()=>{
  // 2e-6 world units is about 1 mm: far below a pixel at 1x, about 0.2 px at 100,000x.
  const w=2e-6,strip=[[[10,9.5],[11,9.5],[11,9.5+w],[10,9.5+w],[10,9.5]]];
  const left=square(9,9),right=square(11,9);
  const piece=U.robustUnion([left,strip,right]);
  assert.ok(Math.abs(piece.outputArea-(2+w))<1e-9,'strip area kept');
  assert.equal(piece.polygons.length,1,'the strip still joins both blocks');
  const withHole=[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[3,1],[3,1+w],[1,1+w],[1,1]]];
  const hole=U.robustUnion([withHole]);
  assert.equal(holes(hole.polygons),1,'narrow hole kept');
  assert.ok(Math.abs(hole.outputArea-(16-2*w))<1e-9);
  for(const input of [[left,strip,right],[withHole]])assert.throws(()=>U.robustUnion(input,{grids:[1e-5]}),/wider than 1e-7 collapse/);
});

test('an enclave inside noisy neighbouring blocks survives as a hole',()=>{
  const noise=v=>v+(Math.sin(v*977)*1e-12);
  const blocks=[];
  for(const [x,y,w,h] of [[0,0,10,4],[0,6,10,4],[0,4,4,2],[6,4,4,2]])blocks.push(square(x,y,w,h).map(r=>r.map(p=>[noise(p[0]),noise(p[1])])));
  const result=U.robustUnion(blocks);
  assert.equal(result.polygons.length,1);assert.equal(holes(result.polygons),1);
  assert.ok(Math.abs(Math.abs(U.ringArea(result.polygons[0][1]))-4)<1e-6);
  assert.ok(Math.abs(result.outputArea-96)<1e-6);
});

test('ring area is computed without cancellation at world coordinates near 1000',()=>{
  const top=1000+2e-12,sliver=[[1000,1000],[1001,1000],[1000.5,top],[1000,1000]];
  assert.equal(Math.abs(U.ringArea(sliver)),(top-1000)/2);
});

test('nestRings nests serialized record subpaths into polygons by containment',()=>{
  const outer=square(0,0,4,4)[0],hole=square(1,1,2,2)[0],island=square(10,10)[0];
  const polys=U.nestRings([island,hole,outer]);
  assert.equal(polys.length,2);
  assert.equal(polys[0][0],outer);assert.equal(polys[0][1],hole);assert.equal(polys[1][0],island);
});

test('robustDifference draws a remainder as the record minus the assigned pieces',()=>{
  const atom=geom=>[geom];
  const result=U.robustDifference([square(0,0,4,4)[0]],[[atom(square(0,0,2,2)),atom(square(0,2,2,2))]],[atom(square(2,0,2,2)),atom(square(2,2,2,2))]);
  assert.equal(result.method,'difference');assert.equal(result.grid,1e-7);
  assert.ok(Math.abs(result.outputArea-8)<1e-9);
  assert.ok(covers(result.polygons,[3,1])&&covers(result.polygons,[3,3]));
  assert.equal(covers(result.polygons,[1,1]),false);
});

test('record gaps are added back: far pieces append and boundary pieces merge',()=>{
  const atom=geom=>[geom];
  const result=U.robustDifference([square(0,0,4,4)[0]],[[atom(square(0,0,2,2)),atom(square(0,2,2,2))]],[atom(square(2,0,2,2)),atom(square(2,2,2,2)),atom(square(10,10)),atom([[[4,0],[5,0],[5,1],[4,1],[4,0]]])]);
  assert.equal(result.method,'difference');
  assert.equal(result.repaired,2);assert.equal(result.appended,1);
  assert.ok(covers(result.polygons,[10.5,10.5]),'a piece clearing the record appends unchanged');
  assert.ok(covers(result.polygons,[4.5,0.5]),'a piece straddling the outline merges in');
  assert.ok(Math.abs(result.outputArea-10)<1e-9);
});

test('a record larger than its mesh fails the area guard and falls back to the exact union',()=>{
  const atom=geom=>[geom];
  const result=U.robustDifference([square(0,0,10,10)[0]],[[atom(square(0,0,2,2))]],[atom(square(2,0,2,2)),atom(square(2,2,2,2))]);
  assert.equal(result.method,'union');assert.match(result.fallbackReason,/exceeds remainder area/);
  assert.ok(Math.abs(result.outputArea-8)<1e-9);
  assert.ok(covers(result.polygons,[3,1])&&covers(result.polygons,[3,3]));
});

test('a partially missing atom is repaired even when its interior probe stays covered',()=>{
  const remainder=[square(1,0,9,10)],before=JSON.stringify(remainder);
  const result=U.robustDifference([square(0,0,10,8)[0]],[[square(0,0,1,10)]],remainder);
  assert.ok(Math.abs(result.outputArea-90)<1e-9);
  assert.ok(covers(result.polygons,[5,9]),'the part beyond the parent record is retained');
  assert.equal(result.repaired,1);
  assert.equal(JSON.stringify(remainder),before);
});

test('equal missing and extra areas cannot disguise a partially uncovered atom',()=>{
  // This record shifts one unit downward. Its missing top strip and extra bottom strip
  // have equal area, and the source atom's probe remains covered.
  const result=U.robustDifference([square(0,-1,10,10)[0]],[[square(0,-1,1,10)]],[square(1,0,9,10)]);
  assert.equal(result.method,'union');assert.match(result.fallbackReason,/exceeds remainder area/);
  assert.ok(covers(result.polygons,[5,9.5]));
  assert.equal(covers(result.polygons,[5,-0.5]),false);
  assert.ok(Math.abs(result.outputArea-90)<1e-9);
});

test('a result hole inside an atom is repaired without filling a genuine source hole',()=>{
  const outer=square(0,0,10,10)[0],recordHole=square(7,7,1,1)[0],assigned=square(0,0,1,10);
  const result=U.robustDifference([outer,recordHole],[[assigned]],[square(1,0,9,10)]);
  assert.ok(covers(result.polygons,[7.5,7.5]));assert.equal(result.repaired,1);
  const source=[square(1,0,9,10)[0],recordHole];
  const genuine=U.robustDifference([outer,recordHole],[[assigned]],[source]);
  assert.equal(covers(genuine.polygons,[7.5,7.5]),false);
  assert.ok(Math.abs(genuine.outputArea-89)<1e-9);
});

test('remainder snapping rejects a ring wider than the world precision instead of dropping it',()=>{
  const thin=square(2.0000016,0,0.0000006,1);
  // Force the fallback grid: the thin remainder collapses, while subject and clip stay wide.
  const subject=[[[0,0],[2.0000022,0],[2.0000022,1],[10,1],[10,10],[0,10],[0,0]]];
  const clip=[[[0,0],[2.0000016,0],[2.0000016,1],[0,1],[0,0]]];
  assert.throws(()=>U.robustDifference(subject,[[clip]],[thin,square(0,1,10,9)],{grids:[1e-6]}),/wider than 1e-7.*collapse/);
});

test('boundary coverage agrees with exact clipping across holes, islands and concave sources',()=>{
  const pieces=[];
  for(let x=0;x<12;x++)for(let y=0;y<12;y++)if((x+y)%3)pieces.push(square(x*3,y*3,2));
  const result=polygonClipping.union(...pieces),check=U.needsCoverageRepair(result);
  let seed=92341;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  for(let i=0;i<600;i++) {
    let poly;
    if(i%4===0) {
      const [x,y]=pieces[Math.floor(random()*pieces.length)][0][0];
      poly=square(x+.2,y+.2,.4);
    }else{
      const x=random()*45-5,y=random()*45-5,w=random()*5+.1;
      poly=i%3===0
        ?[[[x,y],[x+w,y],[x+w,y+w/3],[x+w/3,y+w/3],[x+w/3,y+w],[x,y+w],[x,y]]]
        :square(x,y,w,random()*5+.1);
    }
    const missing=U.geomArea(polygonClipping.difference(poly,result));
    assert.equal(check(poly),missing>1e-9,'coverage sample '+i);
  }
});

test('a difference without a subject or clips falls back to the union instead of throwing',()=>{
  const atom=geom=>[geom];
  const result=U.robustDifference([],[[atom(square(0,0))]],[atom(square(2,2))]);
  assert.equal(result.method,'union');assert.match(result.fallbackReason,/subject and at least one clip/);
  assert.ok(Math.abs(result.outputArea-1)<1e-9);
});

test('balanced reduction matches the chunked union on simple inputs',()=>{
  const tiles=[];for(let x=0;x<23;x++)for(let y=0;y<11;y++)if((x*7+y*3)%11)tiles.push(square(x,y));
  const a=U.balancedUnion(tiles),b=chunked(tiles);
  assert.equal(a.length,b.length);assert.equal(holes(a),holes(b));
  assert.ok(Math.abs(U.geomArea(a)-U.geomArea(b))<1e-9);
  const vertices=g=>g.flat(2).map(p=>p.join(',')).sort();
  assert.deepEqual([...new Set(vertices(a))],[...new Set(vertices(b))]);
  assert.deepEqual(U.balancedUnion([]),[]);
});

test('snapping reports every collapsed ring with its width and never edits its input',()=>{
  const zeroWidth=[[[0,0],[1,0],[1,1e-9],[0,1e-9],[0,0]]];
  const repeated=[[[5,5],[5.00000001,5],[6,5],[6,6],[5,6],[5,5]]];
  const input=[zeroWidth,repeated],before=JSON.stringify(input),collapsed=[];
  const out=U.snapPolygons(input,1e-7,collapsed);
  assert.equal(JSON.stringify(input),before);
  assert.equal(out.length,1);assert.deepEqual(out[0][0][0],[[5,5],[6,5],[6,6],[5,6],[5,5]]);
  assert.equal(collapsed.length,1);assert.ok(collapsed[0].width<=U.QUANTUM);
  // Sub-quantum artifacts are dropped and counted, not hidden.
  const result=U.robustUnion([zeroWidth,square(3,3)]);
  assert.equal(result.droppedRings,1);assert.ok(result.droppedArea>0);
});

test('unrecoverable unions throw every attempt; missing pieces are never returned as success',()=>{
  let calls=0;
  const failing={polygonClipping:{union(){calls++;throw new Error('sweep '+calls);}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/lib/geometry-union.js'),'utf8'),failing);
  assert.throws(()=>failing.CivitasUnion.robustUnion([square(0,0),square(2,0)]),/grid 1e-7: sweep .*; grid 0\.000001: sweep/);
  const dropping={polygonClipping:{union:(...geoms)=>JSON.parse(JSON.stringify(geoms[0]))}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/lib/geometry-union.js'),'utf8'),dropping);
  assert.throws(()=>dropping.CivitasUnion.robustUnion([square(0,0),square(5,0)]),/missing from the union/);
});

function workerSandbox() {
  const posted=[],dir=path.join(__dirname,'../web/lib');
  const sandbox={posted,setTimeout,console,fetch:()=>{throw Error('no fetch in tests');}};
  sandbox.self=sandbox;sandbox.postMessage=message=>posted.push(message);
  sandbox.importScripts=(...files)=>{for(const file of files)vm.runInContext(fs.readFileSync(path.join(dir,file),'utf8'),sandbox);};
  vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(dir,'block-worker.js'),'utf8'),sandbox);
  const settle=count=>new Promise(resolve=>{const poll=()=>posted.length>=count?resolve(posted):setTimeout(poll,1);poll();});
  return {send:data=>sandbox.onmessage({data}),settle};
}
test('worker cancels queued district outlines superseded by a newer request',async()=>{
  const w=workerSandbox();
  for(const id of [1,2,3])w.send({id,operation:'union',groups:{shape:[square(0,0),square(1,0)]},supersede:'district:4'});
  w.send({id:4,operation:'union',groups:{shape:[square(0,0)]},supersede:'district:5'});
  const posted=await w.settle(4);
  assert.deepEqual(posted.filter(m=>m.cancelled).map(m=>m.id),[1,2]);
  const done=posted.filter(m=>!m.cancelled);
  assert.deepEqual(done.map(m=>m.id),[3,4]);
  assert.equal(done[0].groups.shape.length,1);assert.ok(Math.abs(U.geomArea(done[0].groups.shape)-2)<1e-9);
});
test('worker merges a batch of real parents and reports grid and areas per group',async()=>{
  const w=workerSandbox();
  w.send({id:1,operation:'union',groups:{lancaster:fixture('ca-bg-lancaster-060379009012').polygons,palmdale:fixture('ca-bg-palmdale-060379104041').polygons}});
  const [reply]=await w.settle(1);
  assert.equal(Object.keys(reply.errors).length,0);
  assert.equal(reply.grids.lancaster,1e-7);assert.equal(reply.grids.palmdale,1e-7);
  assert.equal(reply.methods.lancaster,'union');assert.equal(reply.methods.palmdale,'union');
  for(const [input,output] of Object.values(reply.areas))assert.ok(output<=input+1e-9&&(input-output)/input<1e-4);
});
test('worker differences a dominant group against its parent record and reports the method',async()=>{
  const w=workerSandbox(),atom=geom=>[geom],record=square(0,0,4,4)[0];
  w.send({id:1,operation:'union',groups:{remainder:{polygons:[atom(square(2,0,2,2)),atom(square(2,2,2,2))],difference:{subject:[record],clips:[[atom(square(0,0,2,2)),atom(square(0,2,2,2))]]}},city:atom(square(0,0,2,2))}});
  const [reply]=await w.settle(1);
  assert.equal(reply.errors.remainder,undefined);assert.equal(reply.errors.city,undefined);
  assert.equal(reply.methods.remainder,'difference');assert.equal(reply.methods.city,'union');
  assert.ok(Math.abs(U.geomArea(reply.groups.remainder)-8)<1e-9);
});
test('a record that fails the difference guards still merges by exact union in the same reply',async()=>{
  const w=workerSandbox(),atom=geom=>[geom];
  w.send({id:1,operation:'union',groups:{remainder:{polygons:[atom(square(2,0,2,2)),atom(square(2,2,2,2))],difference:{subject:[square(0,0,10,10)[0]],clips:[[atom(square(0,0,2,2))]]}}}});
  const [reply]=await w.settle(1);
  assert.equal(reply.errors.remainder,undefined);
  assert.equal(reply.methods.remainder,'fallback');
  assert.ok(Math.abs(U.geomArea(reply.groups.remainder)-8)<1e-9);
});
