#!/usr/bin/env python3
"""Audit parent aggregates and original block counts, without changing any data."""
from pathlib import Path
import argparse,gzip,json,importlib.util,math
from collections import Counter
import numpy as np
from shapely import union_all
from shapely.geometry import Polygon,MultiPolygon

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('builder',ROOT/'scripts/build-block-data.py')
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
def read(path):return json.loads(path.read_text())

def path_ring_signatures(path):
 # Ignore only ring order and starting vertex, retaining winding and every node.
 # This catches stale outlines, fake holes and missing pieces despite unchanged
 # parent statistics. Compare at the producer's actual seven-decimal precision.
 rings=[]
 for chunk in path.split(' Z'):
  chunk=chunk.strip()
  if not chunk:continue
  assert chunk.startswith('M '),'Invalid parent outline path'
  try:points=tuple(tuple(float(value) for value in point.split(',')) for point in chunk[2:].split())
  except ValueError as error:raise AssertionError('Invalid parent outline coordinate') from error
  assert len(points)>=4 and all(len(p)==2 and all(math.isfinite(value) for value in p) for p in points),'Invalid parent outline ring'
  assert points[0]==points[-1],'Unclosed parent outline ring'
  points=points[:-1];first=min(points)
  rings.append(min(points[i:]+points[:i] for i,p in enumerate(points) if p==first))
 return Counter(rings)

def validate(out,completed=False,fixture=False):
 manifest=read(out/'manifest.json')
 if fixture:
  assert manifest.get('fixture') is True,'Expected an explicitly marked test fixture'
  truth=read(out/'source-counts.json');population=truth['blocks']
 else:
  assert not manifest.get('fixture'),'Test fixtures cannot pass release validation'
  assert manifest['sources']==read(ROOT/'scripts/geodata-sources.json'),'Unreviewed source provenance'
  import pandas as pd
  population=pd.read_pickle(ROOT/'.cache/geodata/population.pkl')
 if not completed and not fixture:
  assert len(set(manifest['counties']))==58,'Statewide manifest is incomplete'
  assert manifest['population']==39538223
  assert manifest['blocks']==519723
 reports=sorted((out/'reports').glob('*.json'));checked=[];seen_blocks=set();total_population=0;total_atoms=0
 for path in reports:
  report=read(path)
  if report.get('buildRevision')!=3 or report.get('geometryRevision')!=2:
   assert completed,'Outdated county build: '+path.name
   continue
  slug=report['slug'];assert path.stem==slug
  doc=json.loads(gzip.decompress((out/'atoms'/f'{slug}.json.gz').read_bytes()))
  atoms=doc['atoms'];keys=doc['statKeys'];matrix=np.array([a['stats'] for a in atoms],dtype=np.float64)
  assert len({a['id'] for a in atoms})==len(atoms),'Duplicate atom IDs'
  assert np.isfinite(matrix).all(),'Nonfinite statistics'
  assert len(atoms)==report['atoms']
  geometries=[MultiPolygon([Polygon(poly[0],poly[1:]) for poly in a['polygons']]) for a in atoms]
  assert all(g.is_valid for g in geometries),'Invalid serialized atom geometry'
  assert builder.matching_coverage(geometries),'Atom edges must match without overlaps'
  if fixture:source_geometries=[builder.decode_polygons(truth['sourceGeometry'])]
  else:
   import pyogrio.raw
   from shapely import from_wkb
   _,_,wkb,_=pyogrio.raw.read(ROOT/'.cache/geodata/blocks/tl_2020_06_tabblock20.shp',where=f"COUNTYFP20 = '{report['county']}'",columns=['COUNTYFP20'])
   source_geometries=from_wkb(wkb)
  try:builder.validate_coverage_footprint(geometries,source_geometries)
  except RuntimeError as error:raise AssertionError(str(error)) from error
  assert report['coverage']['revision']==2,'Missing coverage repair audit'
  assert sum(g.is_empty for g in geometries)==report['coverage']['emptyAtoms'],'Wrong empty geometry count'
  for atom,geom in zip(atoms,geometries):
   if geom.is_empty:assert not any(atom['stats']) and not any(any(v) for v in atom['votes'].values()),'Empty atom has nonzero statistics'
  for atom in atoms:
   for race,values in atom['votes'].items():
    assert len(values)==3 and all(type(value) is int and value>=0 for value in values),('Invalid integer votes',slug,atom['id'],race)
  race_matrices={race:np.array([a['votes'].get(race,[0,0,0]) for a in atoms],dtype=np.int64) for race in report['elections']}
  for geo in ['CA','CA-BG']:
   records=read(out/geo/'geometry'/f'precincts-{slug}.json')['records']
   original_ids=truth['parentIds'][geo] if fixture else [r['county']+'|'+str(r['precinct']) for r in read(ROOT/'web/data'/geo/'geometry'/f'precincts-{slug}.json')['records']]
   index={r['county']+'|'+str(r['precinct']):r for r in records}
   assert len(index)==len(records),'Duplicate parent IDs'
   assert all(key in index for key in original_ids),'Lost legacy IDs'
   memberships=doc['parents'][geo]
   _,project=builder.projection(read(out/geo/'geometry/manifest.json')['projection'])
   assert set(memberships)==set(index),'Parent summaries/membership mismatch'
   indices=[i for members in memberships.values() for i in members]
   assert sorted(indices)==list(range(len(atoms))),'Atoms must belong to exactly one parent per geography'
   for key,members in memberships.items():
    totals=matrix[members].sum(axis=0) if members else np.zeros(len(keys))
    for field,total in zip(keys,totals):assert abs(index[key].get(field,0)-total)<.01,(slug,geo,key,field)
    footprint=union_all([geometries[i] for i in members])
    expected=builder.paths_ll(footprint,project)
    assert path_ring_signatures(index[key]['d'])==path_ring_signatures(expected),('Parent outline differs from its atoms',slug,geo,key)
   for race,audit in report['elections'].items():
    data=read(out/geo/race/f'votes-{slug}.json')['records']
    votes={r['county']+'|'+str(r['precinct']):[r['dem'],r['rep'],r['other']] for r in data}
    assert len(votes)==len(data),'Duplicate election parent IDs'
    assert set(votes)<=set(index),'Election references unknown parent'
    totals=np.zeros(3,dtype=np.int64)
    for parent,members in memberships.items():
     expected=race_matrices[race][members].sum(axis=0) if members else np.zeros(3,dtype=np.int64)
     assert votes.get(parent,[0,0,0])==expected.tolist(),(slug,geo,race,parent)
     totals+=expected
    assert totals.tolist()==audit.get('sourceTotals',[0,0,0]),(slug,race,totals.tolist(),audit)
  # Every original block must retain all three official integer counts across cuts.
  blocks={}
  count_columns=[keys.index(k) for k in ['pop20','vap20','pop20Adjusted']]
  for atom,row in zip(atoms,matrix):
   sums=blocks.setdefault(atom['block'],np.zeros(3))
   sums+=row[count_columns]
  assert len(blocks)==report['blocks'],'Wrong original block count'
  assert not seen_blocks.intersection(blocks),'Block duplicated across counties'
  for bid,values in blocks.items():
   expected=population[bid] if fixture else population.loc[bid,['pop20','vap20','pop20Adjusted']].tolist()
   assert values.tolist()==expected,(slug,bid)
  county_population=sum(values[0] for values in blocks.values())
  assert county_population==report['population'],'Wrong county population'
  seen_blocks.update(blocks);total_population+=county_population;total_atoms+=len(atoms)
  checked.append(slug);print('Validated',slug,len(atoms),'pieces',flush=True)
 if not completed:
  assert set(checked)==set(manifest['counties']),'Manifest/report county mismatch'
  assert len(seen_blocks)==manifest['blocks']
  assert total_population==manifest['population']
  assert total_atoms==manifest['atoms']
  if not fixture:assert len(checked)==58
 assert checked,'No counties validated'
 print('PASS:',len(checked),'counties; both geographies, audited races, statistics, original block counts and legacy IDs.')

if __name__=='__main__':
 parser=argparse.ArgumentParser()
 parser.add_argument('--completed',action='store_true')
 parser.add_argument('--fixture',action='store_true')
 parser.add_argument('--root',type=Path,default=ROOT/'web/data/block-v1')
 args=parser.parse_args();validate(args.root,args.completed,args.fixture)
