/* Decompression, parsing and polygon unions run outside the map's UI thread. */
importScripts('../vendor/polygon-clipping.umd.js','geometry-union.js');
const cache=new Map(),queue=[];let draining=false;
// Messages are only queued here. Jobs run one at a time from a timer, so newer messages are
// received between jobs and can supersede queued unions that have not started yet.
self.onmessage=({data})=>{
  if(data.supersede)for(const job of queue)if(job.supersede===data.supersede&&!job.cancelled){job.cancelled=true;self.postMessage({id:job.id,cancelled:true});}
  queue.push(data);if(!draining){draining=true;setTimeout(drain,0);}
};
async function drain() {
  const data=queue.shift();
  if(data&&!data.cancelled)await run(data);
  if(queue.length)setTimeout(drain,0);else draining=false;
}
async function run(data) {
  try {
    if(data.operation==='union') {
      // A failed group is reported by key; the other groups of a batch still merge.
      const groups={},grids={},areas={},errors={},methods={};let stats=null;
      for(const [key,group] of Object.entries(data.groups)) {
        try {
          const spec=group&&group.difference?group.difference:null,polygons=spec?group.polygons:group;
          const timing=data.profile?{}:null,t0=data.profile?performance.now():0;
          const result=spec
            ?CivitasUnion.robustDifference(spec.subject,spec.clips,polygons,timing?{timing}:undefined)
            :CivitasUnion.robustUnion(polygons,timing?{timing}:undefined);
          groups[key]=result.polygons;grids[key]=result.grid;areas[key]=[result.inputArea,result.outputArea];
          methods[key]=spec?(result.fallbackReason?'fallback':'difference'):'union';
          if(timing)(stats??={})[key]={ms:performance.now()-t0,vertices:polygons.reduce((n,mp)=>n+mp.reduce((m,poly)=>m+poly.reduce((k,ring)=>k+ring.length,0),0),0),method:methods[key],...timing};
        }catch(error){errors[key]=error.message;}
      }
      self.postMessage({id:data.id,groups,grids,areas,errors,methods,...(stats?{stats}:{})});return;
    }
    let doc=cache.get(data.url);
    const timing=data.profile?{cached:!!doc}:null;
    if(!doc) {
      const t0=timing&&performance.now();
      const response=await fetch(data.url);
      if(!response.ok)throw new Error('Could not load block data ('+response.status+')');
      const body=data.url.endsWith('.gz') ? response.body.pipeThrough(new DecompressionStream('gzip')) : response.body;
      const text=await new Response(body).text();
      if(timing)timing.streamMs=performance.now()-t0;
      const t1=timing&&performance.now();
      doc=JSON.parse(text);
      if(timing)timing.parseMs=performance.now()-t1;
      cache.set(data.url,doc);
      if(cache.size>3)cache.delete(cache.keys().next().value);
    }
    const parents={},index=doc.parents[data.geography];
    let project;
    if(data.projection) {
      const p=data.projection,D=Math.PI/180,n=(Math.sin(p.lat1*D)+Math.sin(p.lat2*D))/2;
      const C=Math.cos(p.lat1*D)**2+2*n*Math.sin(p.lat1*D),rho0=Math.sqrt(C-2*n*Math.sin(p.lat0*D))/n,lam0=p.lon0*D;
      project=point=>{const rho=Math.sqrt(C-2*n*Math.sin(point[1]*D))/n,th=n*(point[0]*D-lam0);return [(rho*Math.sin(th)-p.xmin)*p.scale,(p.ymax-(rho0-rho*Math.cos(th)))*p.scale];};
    }
    const t2=timing&&performance.now();
    for(const id of data.parents){
      if(!index?.[id])throw new Error('Missing block data for '+id);
      parents[id]=index[id].map(i=>{const rec=doc.atoms[i];return project?{...rec,world:true,polygons:rec.polygons.map(poly=>poly.map(ring=>ring.map(project)))}:rec;});
    }
    if(timing)timing.projectMs=performance.now()-t2;
    self.postMessage({id:data.id,parents,statKeys:doc.statKeys,...(timing?{stats:timing}:{})});
  }catch(error){self.postMessage({id:data.id,error:error.message});}
}
