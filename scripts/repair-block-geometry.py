#!/usr/bin/env python3
"""Repair existing generated geometry without reallocating counts or changing atom IDs."""
import argparse,gzip,hashlib,importlib.util,json,shutil,time
from concurrent.futures import ThreadPoolExecutor,as_completed
from pathlib import Path
import pyogrio.raw
from shapely import from_wkb,union_all
from shapely.ops import transform

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('builder',ROOT/'scripts/build-block-data.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)

def numeric_digest(atoms):
 # Keep the exact original canonical JSON hash without materializing another
 # county-sized list, string and byte buffer during the geometry memory peak.
 digest=hashlib.sha256();digest.update(b'[')
 for i,atom in enumerate(atoms):
  if i:digest.update(b',')
  digest.update(json.dumps({k:v for k,v in atom.items() if k!='polygons'},sort_keys=True,separators=(',',':')).encode())
 digest.update(b']');return digest.hexdigest()

def repair(slug,resume=False,snapping_distance=1e-9):
 started=time.perf_counter()
 report_path=b.OUT/'reports'/f'{slug}.json'
 report=json.loads(report_path.read_text())
 if resume and report.get('geometryRevision')==b.GEOMETRY_REVISION:return
 if report.get('buildRevision')!=3:raise RuntimeError('Build the county before repairing: '+slug)
 atom_path=b.OUT/'atoms'/f'{slug}.json.gz'
 doc=json.loads(gzip.decompress(atom_path.read_bytes()));before=numeric_digest(doc['atoms'])
 meta,_,wkb,fields=pyogrio.raw.read(b.CACHE/'blocks/tl_2020_06_tabblock20.shp',where=f"COUNTYFP20 = '{report['county']}'",columns=['COUNTYFP20','GEOID20'])
 source_fields=dict(zip(meta['fields'],fields))
 if set(source_fields['GEOID20'])!={a['block'] for a in doc['atoms']}:raise RuntimeError('Source block IDs do not match: '+slug)
 print('Repairing',slug,len(doc['atoms']),'atoms',flush=True)
 geoms,coverage=b.repair_atom_geometry(doc['atoms'],from_wkb(wkb),initial_snapping_distance=snapping_distance)
 if numeric_digest(doc['atoms'])!=before:raise RuntimeError('Geometry repair changed nongeometry data: '+slug)
 print('Verified shared-edge mesh for',slug,'after',round(time.perf_counter()-started,1),'seconds; rebuilding parent outlines',flush=True)
 summaries={}
 for geo in b.GEO:
  path=b.OUT/geo/'geometry'/f'precincts-{slug}.json'
  summary=json.loads(path.read_text());records={r['county']+'|'+str(r['precinct']):r for r in summary['records']}
  projection=json.loads((b.OUT/geo/'geometry/manifest.json').read_text())['projection'];_,fwd=b.projection(projection)
  for key,members in doc['parents'][geo].items():
   footprint=union_all([geoms[i] for i in members]);record=records[key]
   record['d']=b.paths_ll(footprint,fwd);record['empty']=footprint.is_empty
   if not footprint.is_empty:record['bbox']=list(transform(fwd,footprint).bounds)
  summaries[path]=summary
  print('Rebuilt',len(records),geo,'outlines for',slug,'after',round(time.perf_counter()-started,1),'seconds',flush=True)
 # Keep the first input version for local diagnosis/recovery. Publish the report last
 # so an interrupted county is retried; the release certificate rejects partial writes.
 backup=ROOT/'.cache/geometry-before-repair'/slug
 for path in [atom_path,report_path,*summaries]:
  destination=backup/path.relative_to(b.OUT)
  if not destination.exists():
   destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,destination)
 b.write_json(atom_path,doc,True)
 for path,summary in summaries.items():b.write_json(path,summary)
 report.update(geometryRevision=b.GEOMETRY_REVISION,coverage={**coverage,'preservedNongeometrySha256':before})
 b.write_json(report_path,report)
 print('Repaired',slug,'with identical atom IDs, statistics, votes and memberships',flush=True)
 print('Completed',slug,'in',round(time.perf_counter()-started,1),'seconds',flush=True)

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--counties',nargs='+');parser.add_argument('--resume',action='store_true');parser.add_argument('--jobs',type=int,choices=range(1,5),default=1)
 parser.add_argument('--snapping-distance',type=float,choices=[1e-9,1e-10,1e-11,1e-12],default=1e-9,help='Start at a known finer noding tolerance; all audit guards still apply.')
 args=parser.parse_args()
 slugs=args.counties or json.loads((b.OUT/'manifest.json').read_text())['counties']
 if args.jobs==1:
  for slug in slugs:repair(slug,args.resume,args.snapping_distance)
 else:
  # Separate counties have separate atomic outputs. Bound GEOS memory use rather
  # than creating one worker per county; each thread opens its own source dataset.
  with ThreadPoolExecutor(max_workers=args.jobs) as pool:
   futures={pool.submit(repair,slug,args.resume,args.snapping_distance):slug for slug in slugs}
   try:
    for future in as_completed(futures):
     try:future.result()
     except BaseException as error:
      print('Failed',futures[future],str(error),flush=True)
      raise
   except BaseException:
    for future in futures:future.cancel()
    raise
