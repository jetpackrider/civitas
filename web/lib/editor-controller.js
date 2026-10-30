(function(root) {
  'use strict';
    const {History,aggregate,setElectionMargin,SpatialIndex,copy}=root.CivitasEditor;
  root.createCivitasController=function(bridge) {
    const worker=new Worker('lib/block-worker.js'),pending=new Map();let serial=0;
    worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);if(data.cancelled)unionStats.cancelled++;data.error?p.reject(new Error(data.error)):p.resolve(data);};
    worker.onerror=()=>{for(const p of pending.values())p.reject(new Error('The geometry worker stopped. Reload the map to continue.'));pending.clear();};
    const request=data=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});worker.postMessage({...data,id});});
    let parents=[],index={},cities=[],cityIndex=null,shapeIndex=null,citiesReady=Promise.resolve();
    let opened=null,hoverCity=null,pointer=[0,0],history=new History(),before=null,label='',generation=0,busy=false;
    let statKeys=[],merged=new Map(),merging=new Set(),viewToken=0,visibleRecords=[];
    // Parent merges requested during one sync are sent to the worker in batches. Merged outlines
    // are display-only (displayRings); rings and _polygons stay the exact atom geometry used for
    // picking, district outlines, statistics and export.
    const BATCH_VERTEX_LIMIT=60000;
    let mergeQueue=new Map(),mergeTimer=null,mergesInFlight=0,settledWaiters=[];
    const unionStats={batches:0,groups:0,failed:0,retried:0,district:0,cancelled:0,differenced:0,fallbacks:0};
    const status=document.getElementById('editor-status'),done=document.getElementById('block-done');
    let statusTimer=null;
    function notice(text,error=false,lasting=false) {
      clearTimeout(statusTimer);status.textContent=text;status.classList.toggle('error',error);status.hidden=false;
      if(!lasting)statusTimer=setTimeout(()=>{status.hidden=true;},error?10000:5000);
    }
    function bbox(rings) {
      const b=[Infinity,Infinity,-Infinity,-Infinity];
      for(const ring of rings)for(const p of ring){b[0]=Math.min(b[0],p[0]);b[1]=Math.min(b[1],p[1]);b[2]=Math.max(b[2],p[0]);b[3]=Math.max(b[3],p[1]);}
      return b;
    }
    function geometry(polygons) {
      const projected=polygons.map(poly=>poly.map(ring=>ring.map(p=>bridge.project(p[0],p[1]))));
      return {polygons:projected,rings:projected.flat()};
    }
    function updates() {
      document.getElementById('population-basis').disabled=busy||bridge.readOnly();
      document.getElementById('editor-undo').disabled=busy||bridge.readOnly()||!history.canUndo;
      document.getElementById('editor-redo').disabled=busy||bridge.readOnly()||!history.canRedo;
      document.getElementById('editor-undo').title=history.canUndo?'Undo '+history.commands[history.cursor-1].label:'Undo';
      document.getElementById('editor-redo').title=history.canRedo?'Redo '+history.commands[history.cursor].label:'Redo';
      done.hidden=!opened;done.textContent=opened?'Done · '+opened.precinct:'Done';
    }
    function snapshot() {
      const assignments={};
      for(const p of parents) {
        const overrides={};
        if(p._children)for(const a of p._children)if(a.districtId!==p.districtId)overrides[a.id]=a.districtId;
        if(p.districtId!==null||Object.keys(overrides).length)assignments[p._id]={district:p.districtId,overrides};
      }
      const meta=bridge.meta();
      return {assignments,meta:{count:meta.count,mode:meta.mode,name:meta.name,basis:meta.basis},names:copy(meta.names),locked:copy(meta.locked)};
    }
    function begin(text) {if(!before&&!busy&&!bridge.readOnly()){before=snapshot();label=text;}}
    function finish() {
      if(!before)return false;
      const start=before;before=null;
      const changed=history.record(label,start,snapshot());
      if(changed){bridge.changed();bridge.persist();}updates();return changed;
    }
    async function ensure(ids) {
      const token=generation,batches=new Map();
      for(const id of ids) {
        const p=index[id];if(!p)throw new Error('This map refers to an unknown '+bridge.unit()+': '+id);
        if(p._children)continue;
        if(!p.atomFile)throw new Error('Block data is unavailable for '+p.precinct);
        if(!batches.has(p.atomFile))batches.set(p.atomFile,[]);batches.get(p.atomFile).push(id);
      }
      // Bound concurrent requests and memory use for municipalities crossing counties.
      for(const [file,keys] of batches) {
        for(let offset=0;offset<keys.length;offset+=8) {
        const data=await request({url:new URL(file,location.href).href,parents:keys.slice(offset,offset+8),geography:bridge.geography(),projection:bridge.projection?.()});
        if(token!==generation)throw new Error('The map changed while loading blocks.');
        statKeys=[...new Set([...data.statKeys,'dem','rep','other','shAd','shAr','shAo','shBd','shBr','shBo'])];
        for(const [id,records] of Object.entries(data.parents)) {
          const parent=index[id];
          if(parent._children)continue;
          parent._version=(parent._version||0)+1;
          parent._children=records.map(rec=>{
            const g=rec.world?{polygons:rec.polygons,rings:rec.polygons.flat()}:geometry(rec.polygons),values={};
            data.statKeys.forEach((key,i)=>{values[key]=rec.stats[i];});
            return {...values,id:rec.id,blockId:rec.block,cityId:rec.city,_votes:rec.votes,_parent:parent,_polygons:g.polygons,rings:g.rings,paths:[null,null,null],bbox:bbox(g.rings),districtId:parent.districtId,estimated:rec.estimated,county:parent.county,precinct:'Block '+rec.block.slice(-4),fill:'#e3e5e9'};
          });
          for(const a of parent._children){a.bboxArea=(a.bbox[2]-a.bbox[0])*(a.bbox[3]-a.bbox[1]);a._atoms=[a];}
        }
        await new Promise(resolve=>setTimeout(resolve,0));
        }
      }
    }
    function syncValues(a) {
      const race=bridge.race();const votes=a._votes[race?.key]||[0,0,0];[a.dem,a.rep,a.other]=votes;
      const shift=bridge.shift();const va=a._votes[shift.from]||[0,0,0],vb=a._votes[shift.to]||[0,0,0];
      [a.shAd,a.shAr,a.shAo]=va;[a.shBd,a.shBr,a.shBo]=vb;
      setElectionMargin(a);
      a.inc_med=a.inc_medhh?a.inc_medw/a.inc_medhh:0;a.age_avg=a.age_total?a.age_sum/a.age_total:0;
    }
    function groupShape(p,atoms,key,blockId,difference) {
      if(atoms.length===1&&opened===p)return atoms[0];
      const values=aggregate(atoms,statKeys),rings=atoms.flatMap(a=>a.rings),signature=atoms.map(a=>a.id).join(',');
      const cached=merged.get(signature);
      const g={...values,county:p.county,precinct:blockId?'Block '+blockId.slice(-4):p.precinct+' · '+(key==='null'?'unassigned':'District '+key),districtId:atoms[0].districtId,_polygons:atoms.flatMap(a=>a._polygons),rings,displayRings:cached?cached.flat():null,paths:[null,null,null],_parent:p,_atoms:atoms,_signature:signature,blockId,estimated:atoms.some(a=>a.estimated),fill:'#e3e5e9'};
      g.bbox=bbox(g.rings);g.bboxArea=(g.bbox[2]-g.bbox[0])*(g.bbox[3]-g.bbox[1]);
      if(!merged.has(signature)&&!merging.has(signature)) {
        const vertices=rings.reduce((n,r)=>n+r.length,0);
        merging.add(signature);mergeQueue.set(signature,{parent:p,vertices,polygons:atoms.map(a=>a._polygons),difference});
        if(!mergeTimer)mergeTimer=setTimeout(flushMerges,0);
      }
      return g;
    }
    function settleMerges() {
      if(mergeQueue.size||mergesInFlight)return;
      const waiters=settledWaiters;settledWaiters=[];for(const resolve of waiters)resolve();
    }
    function flushMerges() {
      mergeTimer=null;if(!mergeQueue.size)return;
      // Smaller groups first, in requests of bounded size, so most outlines appear quickly.
      const items=[...mergeQueue].sort((a,b)=>a[1].vertices-b[1].vertices);mergeQueue=new Map();
      for(let i=0;i<items.length;) {
        const batch=new Map();let vertices=0;
        while(i<items.length&&(!batch.size||vertices+items[i][1].vertices<=BATCH_VERTEX_LIMIT)){batch.set(items[i][0],items[i][1]);vertices+=items[i][1].vertices;i++;}
        sendMerges(batch);
      }
    }
    function sendMerges(batch) {
      const token=generation,groups={};let settled=false;
      for(const [signature,item] of batch){groups[signature]=item.difference?{polygons:item.polygons,difference:item.difference}:item.polygons;}
      mergesInFlight+=batch.size;unionStats.batches++;
      // Runs exactly once per batch, whatever happens to the reply.
      const settle=()=>{if(settled)return;settled=true;mergesInFlight-=batch.size;if(token===generation)for(const signature of batch.keys())merging.delete(signature);settleMerges();};
      request({operation:'union',groups}).then(data=>{
        settle();
        if(token!==generation)return;
        const failures=[];
        for(const [signature,polygons] of Object.entries(data.groups)) {
          unionStats.groups++;if(data.grids?.[signature]>1e-7)unionStats.retried++;
          if(data.methods?.[signature]==='difference')unionStats.differenced++;else if(data.methods?.[signature]==='fallback')unionStats.fallbacks++;
          merged.set(signature,polygons);if(merged.size>512)merged.delete(merged.keys().next().value);
        }
        for(const [signature,message] of Object.entries(data.errors||{})){unionStats.failed++;merged.set(signature,null);failures.push(batch.get(signature).parent.precinct+': '+message);}
        // Presentation only: exact rings stay for picking, outlines, totals and history.
        let changed=false;
        for(const current of visibleRecords) {
          const polygons=Object.hasOwn(data.groups,current._signature)?data.groups[current._signature]:null;
          if(!polygons)continue;
          current.displayRings=polygons.flat();current.displayPaths=null;changed=true;
        }
        if(failures.length)notice('Block outline could not merge for '+failures.join('; ')+'. Its blocks are shown individually.',true);
        if(changed)(bridge.geometryChanged||bridge.redraw)();
      }).catch(error=>{settle();if(token===generation)notice('Block outlines could not merge: '+error.message,true);});
    }
    function sync() {
      const visible=[];
      for(const p of parents) {
        if(!p._children||!p._children.length){visible.push(p);continue;}
        const race=bridge.race()?.key,shift=bridge.shift(),cache=p._viewCache;
        if(cache&&cache.version===(p._version||0)&&cache.open===(opened===p)&&cache.race===race&&cache.from===shift.from&&cache.to===shift.to){visible.push(...cache.shapes);continue;}
        const start=visible.length,groups=new Map();
        for(const a of p._children) {
          syncValues(a);
          const key=opened===p?a.blockId+'|'+a.districtId:String(a.districtId);
          if(!groups.has(key))groups.set(key,[]);groups.get(key).push(a);
        }
        if(opened!==p&&groups.size===1) {
          p.districtId=p._children[0].districtId;visible.push(p);
        }else{
          // The dominant group of a mixed parent (more than half its vertices, nearly always the
          // unassigned remainder after a city paint) is drawn as the parent record minus the
          // merged rest; the worker's guards fall back to the exact union whenever the record
          // disagrees with the block mesh, so the outline never loses a block.
          const ranked=[...groups.values()].map(atoms=>({atoms,vertices:atoms.reduce((n,a)=>n+a.rings.reduce((m,r)=>m+r.length,0),0)}));
          const total=ranked.reduce((n,g)=>n+g.vertices,0);
          let members=null;
          for(const {atoms,vertices} of ranked) {
            let difference=null;
            if(opened!==p&&p.rings&&p.rings.length&&vertices*2>total) {
              members??=new Set(atoms);
              difference={subject:p.rings,clips:[p._children.filter(a=>!members.has(a)).map(a=>a._polygons)]};
            }
            visible.push(groupShape(p,atoms,String(atoms[0].districtId),opened===p?atoms[0].blockId:null,difference));
          }
        }
        p._viewCache={version:p._version||0,open:opened===p,race,from:shift.from,to:shift.to,shapes:visible.slice(start)};
      }
      const geometryChanged=visible.length!==visibleRecords.length||visible.some((s,i)=>s!==visibleRecords[i]);
      visibleRecords=visible;if(geometryChanged||!shapeIndex)shapeIndex=new SpatialIndex(visible);bridge.shapes(visible);viewToken++;updates();
    }
    function closeBlocks() {if(!opened)return;opened=null;sync();bridge.refresh();}
    async function openBlocks(p) {
      if(busy)return;
      busy=true;updates();notice('Loading blocks…',false,true);
      try {
        await ensure([p._id]);opened=p;sync();bridge.zoom(p.bbox);bridge.refresh();
        notice('Paint individual blocks. Done closes block detail.');
      }catch(error){notice(error.message,true);}finally{busy=false;updates();}
    }
    function assignAtoms(atoms,district,locks) {
      const changed=[];
      for(const a of atoms){if(a.districtId!==null&&locks[a.districtId])continue;if(a.districtId===district)continue;a.districtId=district;a._parent._version=(a._parent._version||0)+1;changed.push(a);}
      return changed;
    }
    async function paintCity(city,tool,district,locks) {
      if(busy||bridge.readOnly())return;
      busy=true;updates();notice('Loading '+city.name+'…',false,true);
      try {
        await ensure(city.parents);
        busy=false;begin((tool==='eraser'?'Erase ':'Paint ')+city.name);busy=true;
        const atoms=city.parents.flatMap(id=>index[id]._children).filter(a=>a.cityId===city.id);
        const skipped=atoms.filter(a=>a.districtId!==null&&locks[a.districtId]&&a.districtId!==(tool==='eraser'?null:district)).length;
        const changed=assignAtoms(atoms,tool==='eraser'?null:district,locks);
        opened=null;sync();finish();bridge.refresh();
        notice(city.name+': '+(changed.length?'updated':'no changes')+(skipped?' · some pieces belong to locked districts':''));
      }catch(error){before=null;notice(error.message,true);}finally{busy=false;updates();}
    }
    function apply(s,tool,paintBy,district,locks) {
      if(busy||bridge.readOnly())return [];
      if(paintBy==='city') {
        if(!hoverCity){notice('Choose an incorporated city. This area is unincorporated.');return [];}
        paintCity(hoverCity,tool,district,locks);return [];
      }
      const p=s._parent||s;
      if(paintBy==='block'&&opened!==p){openBlocks(p);return [];}
      begin((tool==='eraser'?'Erase':'Paint')+(paintBy==='county'?' county':' stroke'));
      const target=tool==='eraser'?null:district,changed=[];
      const targets=paintBy==='county'?parents.filter(x=>x.county===p.county):[s];
      for(const x of targets) {
        if(x._atoms)changed.push(...assignAtoms(x._atoms,target,locks));
        else if(x._children)changed.push(...assignAtoms(x._children,target,locks));
        else if((x.districtId===null||!locks[x.districtId])&&x.districtId!==target){x.districtId=target;changed.push(x);}
      }
      return changed;
    }
    async function validateSnapshot(state) {
      if(!Number.isInteger(state.meta.count)||state.meta.count<0||state.meta.count>1000)throw new Error('Invalid district count');
      if(!['census','adjusted'].includes(state.meta.basis))throw new Error('Invalid population basis');
      for(const [section,values] of [['names',state.names],['locked',state.locked]]) {
        if(!values||typeof values!=='object'||Array.isArray(values))throw new Error('Invalid district '+section);
        const keys=Object.keys(values);
        if(keys.length>state.meta.count)throw new Error('Invalid district '+section+' count');
        for(const key of keys) {
          const district=Number(key),value=values[key];
          if(!Number.isInteger(district)||district<1||district>state.meta.count||String(district)!==key)throw new Error('Invalid district '+section+' key');
          if(section==='names'?(typeof value!=='string'||value.length>40):typeof value!=='boolean')throw new Error('Invalid district '+section+' value');
        }
      }
      for(const id of Object.keys(state.assignments))if(!Object.hasOwn(index,id))throw new Error('Unknown map unit: '+id);
      await ensure(Object.entries(state.assignments).filter(([,v])=>Object.keys(v.overrides||{}).length).map(([id])=>id));
      // Validate the entire state before mutating any assignment.
      for(const p of parents) {
        const saved=state.assignments[p._id]||{district:null,overrides:{}};
        const district=saved.district??null;
        if(district!==null&&(!Number.isInteger(district)||district<1||district>state.meta.count))throw new Error('Invalid district assignment');
        const overrides=saved.overrides||{};
        if(p._children) {
          const valid=new Set(p._children.map(a=>a.id));
          for(const [id,value] of Object.entries(overrides)) {
            if(!valid.has(id))throw new Error('Unknown block assignment: '+id);
            if(value!==null&&(!Number.isInteger(value)||value<1||value>state.meta.count))throw new Error('Invalid block district assignment');
          }
        }
      }
    }
    async function applySnapshot(state) {
      await validateSnapshot(state);
      for(const p of parents) {
        const saved=state.assignments[p._id]||{district:null,overrides:{}};
        p._version=(p._version||0)+1;p.districtId=saved.district??null;
        if(p._children)for(const a of p._children)a.districtId=Object.hasOwn(saved.overrides||{},a.id)?saved.overrides[a.id]:p.districtId;
      }
      bridge.setMeta({...state.meta,names:copy(state.names),locked:copy(state.locked)});sync();bridge.refresh();
    }
    async function undoRedo(direction) {
      if(busy||bridge.readOnly())return;
      finish();const oldCursor=history.cursor;
      const next=direction==='undo'?history.undo(snapshot()):history.redo(snapshot());if(!next)return;
      busy=true;updates();
      try{await applySnapshot(next);bridge.changed();bridge.persist();notice(direction==='undo'?'Undone':'Redone');}
      catch(error){history.cursor=oldCursor;notice(error.message,true);}finally{busy=false;updates();}
    }
    function payloadState(payload,name) {
      if(payload.version&&payload.version>2)throw new Error('Unsupported map version');
      if(payload.dataset&&payload.dataset!==bridge.dataset())throw new Error('This map uses an unavailable dataset.');
      const assignments=payload.unitAssignments||Object.fromEntries(Object.entries(payload.assignments||{}).map(([id,district])=>[id,{district,overrides:{}}]));
      for(const id of Object.keys(assignments))if(!Object.hasOwn(index,id))throw new Error('Map geography could not be matched: '+id);
      return {assignments,meta:{count:payload.count,mode:payload.mode||'by-district',name,basis:payload.populationBasis||'census'},names:payload.names||{},locked:payload.locked||{}};
    }
    async function restore(payload,name) {
      const state=payloadState(payload,name),restoredHistory=new History(payload.history);
      busy=true;updates();
      try {await applySnapshot(state);opened=null;before=null;history=restoredHistory;sync();}
      finally {busy=false;updates();}
      if(!payload.dataset)notice('Map upgraded: district totals now use 2020 Census blocks. An original recovery copy is retained.');
    }
    const api={
      initialize(records){generation++;parents=records.slice();index=Object.fromEntries(parents.map(p=>[p._id,p]));statKeys=bridge.statKeys();opened=null;cities=[];cityIndex=null;shapeIndex=null;visibleRecords=[];hoverCity=null;merged.clear();merging.clear();mergeQueue.clear();settleMerges();before=null;history=new History();sync();
        if(!parents.length){citiesReady=Promise.resolve();return;}
        const token=generation;citiesReady=bridge.fetchCities().then(doc=>{if(token!==generation)return;cities=doc.records.map(c=>({...c,rings:bridge.parse(c.d),paths:[null,null,null]}));cityIndex=new SpatialIndex(cities);bridge.redraw();});citiesReady.catch(error=>notice('City boundaries could not load: '+error.message,true));},
      resetMap(){opened=null;before=null;history=new History();for(const p of parents){p._version=(p._version||0)+1;p.districtId=null;if(p._children)for(const a of p._children)a.districtId=null;}bridge.setBasis('census');sync();},
      apply,sync,begin,finish,closeBlocks,snapshot,restore,notice,undoRedo,openBlocks,paintCity,
      validatePayload:(payload,name)=>validateSnapshot(payloadState(payload,name)),
      // Resolves null when a newer request for the same key superseded this one before it ran.
      async unionGeometry(polygons,key) {
        unionStats.district++;
        const data=await request({operation:'union',groups:{shape:polygons},supersede:key===undefined?undefined:'district:'+key});
        if(data.cancelled)return null;
        if(data.errors?.shape)throw new Error(data.errors.shape);
        return data.groups.shape;
      },
      mergesSettled:()=>mergeQueue.size||mergesInFlight?new Promise(resolve=>settledWaiters.push(resolve)):Promise.resolve(),
      pickCandidates:(x,y)=>shapeIndex?shapeIndex.at(x,y):null,
      pointer(x,y){pointer=[x,y];const previous=hoverCity;hoverCity=null;if(cityIndex)for(const c of cityIndex.at(x,y)){if(bridge.contains(c,x,y)){hoverCity=c;break;}}if(previous!==hoverCity&&bridge.paintBy()==='city')bridge.redraw();},
      overlay(ctx,scale){if(bridge.paintBy()==='city'||document.getElementById('show-city-borders').checked){
        const bounds=bridge.viewport?.(),visible=bounds&&cityIndex?cityIndex.range(bounds):cities;
        ctx.strokeStyle='#24cbd1';ctx.lineWidth=1.2/scale;
        for(const c of visible){const path=bridge.displayPath?bridge.displayPath(c,scale):bridge.path(c);if(hoverCity===c&&bridge.paintBy()==='city'){ctx.fillStyle='rgba(36,203,209,.14)';ctx.fill(path);ctx.lineWidth=2.5/scale;}ctx.stroke(path);ctx.lineWidth=1.2/scale;}
      }if(opened){ctx.strokeStyle='#24cbd1';ctx.lineWidth=2.5/scale;ctx.stroke(bridge.path(opened));}},
      endStroke(){sync();finish();bridge.refresh();},
      metadataChanged(text,fn){if(busy||bridge.readOnly()){updates();return;}begin(text);fn();sync();finish();bridge.refresh();},
      reduceCount(n){const meta=bridge.meta();for(const section of [meta.names,meta.locked])for(const key of Object.keys(section))if(Number(key)>n)delete section[key];for(const p of parents){p._version=(p._version||0)+1;if(p.districtId>n)p.districtId=null;if(p._children)for(const a of p._children)if(a.districtId>n)a.districtId=null;}},
      exportState(){const state=snapshot();return {version:2,dataset:bridge.dataset(),populationBasis:state.meta.basis,unitAssignments:state.assignments,history:history.persistent()};},
      districtVotes(records,race){const result={};for(const r of records){const p=index[r.county+'|'+r.precinct];if(!p)continue;
        const pieces=p._children||[p];for(const a of pieces){if(a.districtId===null)continue;const votes=p._children?(a._votes[race.key]||[0,0,0]):[r.dem,r.rep,r.other];const v=result[a.districtId]||(result[a.districtId]=[0,0,0]);for(let i=0;i<3;i++)v[i]+=votes[i];}}
        return result;},
      get parents(){return parents;},get mergesPending(){return mergeQueue.size+mergesInFlight;},get unionStats(){return {...unionStats};},get busy(){return busy;},get opened(){return opened;},get history(){return history;},get cities(){return cities;},get ready(){return citiesReady;}
    };
    done.addEventListener('click',closeBlocks);
    document.getElementById('editor-undo').addEventListener('click',()=>undoRedo('undo'));
    document.getElementById('editor-redo').addEventListener('click',()=>undoRedo('redo'));
    document.getElementById('show-city-borders').addEventListener('change',bridge.redraw);
    document.getElementById('population-basis').addEventListener('change',event=>api.metadataChanged('Population basis',()=>bridge.setBasis(event.target.value)));
    root.addEventListener('civitas-history',event=>undoRedo(event.detail));
    root.addEventListener('civitas-storage-error',event=>notice('Could not save this map: '+event.detail,true,true));
    document.addEventListener('keydown',event=>{
      if(event.target.closest('input,textarea,[contenteditable="true"]'))return;
      if(event.key==='Escape'&&opened){closeBlocks();return;}
      if(!(event.metaKey||event.ctrlKey))return;
      if(event.key.toLowerCase()==='z'){event.preventDefault();undoRedo(event.shiftKey?'redo':'undo');}
      else if(event.ctrlKey&&event.key.toLowerCase()==='y'){event.preventDefault();undoRedo('redo');}
    });
    updates();return api;
  };
})(globalThis);
