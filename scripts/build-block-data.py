#!/usr/bin/env python3
"""Build shared census atoms, parent summaries and race aggregates for offline editing.

All overlay work uses California Albers metres. Geometry is partitioned rather than
assigning blocks by a centroid. Counts use deterministic largest-remainder allocation.
Original inputs are never modified. Run fetch-geodata.py first.
"""
from pathlib import Path
from collections import defaultdict
import argparse,csv,gzip,hashlib,json,math,re,zipfile,warnings
warnings.filterwarnings("ignore", category=DeprecationWarning)
import numpy as np
import pandas as pd
import pyogrio.raw
from pyproj import Transformer
from shapely import STRtree,from_wkb,make_valid,union_all,intersection,difference,set_precision
from shapely.geometry import Polygon,MultiPolygon,GeometryCollection,mapping
from shapely.ops import transform

ROOT=Path(__file__).resolve().parents[1];CACHE=ROOT/'.cache/geodata';WEB=ROOT/'web';OUT=WEB/'data/block-v1'
DATASET='ca-blocks-2020-cities-2025-v1'
GEO=['CA','CA-BG'];TO_M=Transformer.from_crs(4269,3310,always_xy=True).transform;TO_LL=Transformer.from_crs(3310,4269,always_xy=True).transform
RACE_PREFIX={'president':'PRS','senate':'USS','governor':'GOV','lieutenant-governor':'LTG','attorney-general':'ATG','secretary-of-state':'SOS','controller':'CON','treasurer':'TRS','insurance-commissioner':'INS','superintendent':'SPI','house':'CNG'}

def write_json(path,value,compressed=False):
 path.parent.mkdir(parents=True,exist_ok=True)
 text=json.dumps(value,separators=(',',':'),allow_nan=False).encode()
 temporary=path.with_name(path.name+'.tmp')
 if compressed:
  with temporary.open('wb') as raw:
   with gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as f:f.write(text)
 else:temporary.write_bytes(text)
 temporary.replace(path)

def allocate(total,weights):
 total=int(round(total));w=np.maximum(np.asarray(weights,dtype=float),0);s=w.sum()
 exact=total*(w/s if s else np.ones(len(w))/len(w));out=np.floor(exact).astype(np.int64)
 remain=total-int(out.sum());order=np.argsort(-(exact-out),kind='stable');out[order[:remain]]+=1
 return out

def polygons(geom):
 if geom.is_empty:return []
 if geom.geom_type=='Polygon':return [geom]
 if geom.geom_type in ['MultiPolygon','GeometryCollection']:return [p for g in geom.geoms for p in polygons(g)]
 return []

def clean(geom):
 ps=polygons(make_valid(geom));return set_precision(union_all(ps),.001) if ps else Polygon()

def projection(p):
 d=math.pi/180;n=(math.sin(p['lat1']*d)+math.sin(p['lat2']*d))/2
 c=math.cos(p['lat1']*d)**2+2*n*math.sin(p['lat1']*d);rho0=math.sqrt(c-2*n*math.sin(p['lat0']*d))/n
 def inv(x,y,z=None):
  x=np.asarray(x)/p['scale']+p['xmin'];y=p['ymax']-np.asarray(y)/p['scale'];dy=rho0-y
  return (p['lon0']*d+np.arctan2(x,dy)/n)/d,np.arcsin(np.clip((c-(x*x+dy*dy)*n*n)/(2*n),-1,1))/d
 def fwd(x,y,z=None):
  rho=np.sqrt(c-2*n*np.sin(np.asarray(y)*d))/n;th=n*(np.asarray(x)*d-p['lon0']*d)
  return (rho*np.sin(th)-p['xmin'])*p['scale'],(p['ymax']-(rho0-rho*np.cos(th)))*p['scale']
 return inv,fwd

def from_path(d,inv):
 rings=[]
 for ring in d.split(' Z'):
  points=[tuple(map(float,x.split(','))) for x in ring.strip().removeprefix('M').split() if ',' in x]
  if len(points)>=3:rings.append(Polygon(points))
 # SVG uses nonzero winding; determine holes by nesting, independent of orientation.
 rings.sort(key=lambda g:-g.area);geom=Polygon()
 for ring in rings:geom=geom.symmetric_difference(ring)
 return clean(transform(TO_M,transform(inv,geom)))

def paths(geom,fwd):
 geom=transform(fwd,transform(TO_LL,geom));out=[]
 for poly in polygons(geom):
  for ring in [poly.exterior,*poly.interiors]:out.append('M '+' '.join(f'{x:.7f},{y:.7f}' for x,y in ring.coords)+' Z')
 return ' '.join(out)

def ll_polys(geom):
 return [[[ [round(x,7),round(y,7)] for x,y in ring.coords] for ring in [p.exterior,*p.interiors]] for p in polygons(transform(TO_LL,geom))]

def partition(geom,tree,geoms,ids):
 remaining=geom
 candidates=tree.query(geom,predicate='intersects')
 # Stable order handles any overlapping/simplified legacy footprints deterministically.
 for i in sorted(candidates,key=lambda i:ids[i]):
  if remaining.is_empty:break
  part=clean(intersection(remaining,geoms[i],grid_size=.001))
  if part.area<=1e-8:continue
  yield ids[i],part
  remaining=clean(difference(remaining,part,grid_size=.001))
 if remaining.area>1e-8:yield None,remaining

def source_tables():
 p=CACHE/'population.pkl'
 if p.exists():return pd.read_pickle(p)
 z=zipfile.ZipFile(CACHE/'pl2020.zip');lookup={}
 with z.open('cageo2020.pl') as f:
  for line in f:
   row=line.decode('latin1').rstrip().split('|')
   if row[2]=='750':lookup[row[7]]=row[9]
 values={bid:{'pop20':0,'vap20':0,'pop20Adjusted':0} for bid in lookup.values()}
 for name,key in [('ca000012020.pl','pop20'),('ca000022020.pl','vap20')]:
  with z.open(name) as f:
   for line in f:
    row=line.decode('ascii').split('|',6)
    bid=lookup.get(row[4])
    if bid:values[bid][key]=int(row[5])
 az=zipfile.ZipFile(CACHE/'adjusted.zip')
 with az.open('state_PL94_2020_Adjusted_P24_DOJ_Block.csv') as f:
  for row in csv.DictReader((line.decode() for line in f)):
   if row['BLOCK20'] in values:values[row['BLOCK20']]['pop20Adjusted']=int(row['Population P2'])
 frame=pd.DataFrame.from_dict(values,orient='index');frame.to_pickle(p);return frame

def prepare_elections():
 dest=CACHE/'election-counties';dest.mkdir(exist_ok=True)
 for year in ['16','18','20','22','24']:
  if (dest/f'g{year}-fips-ready').exists():continue
  z=zipfile.ZipFile(CACHE/f'g{year}-votes.zip');name=next(n for n in z.namelist() if n.endswith('.csv') and 'headers' not in n)
  with z.open(name) as f:frame=pd.read_csv(f,dtype=str,keep_default_na=False)
  countycol='COUNTY20' if 'COUNTY20' in frame.columns else 'FIPS'
  for county,part in frame.groupby(countycol):part.to_pickle(dest/f'{str(county)[-3:].zfill(3)}-g{year}.pkl')
  (dest/f'g{year}-fips-ready').touch()
 for year in ['22','24']:
  if (dest/f'g{year}-fips-map-ready').exists():continue
  frame=pd.read_csv(CACHE/f'g{year}-block-map.csv',dtype=str,keep_default_na=False)
  for county,part in frame.groupby('FIPS'):part.to_pickle(dest/f'{str(county)[-3:].zfill(3)}-g{year}-map.pkl')
  (dest/f'g{year}-fips-map-ready').touch()

def norm(text):return re.sub(r'[^a-z0-9]','',str(text).lower().split('(')[0].replace('*',''))

def vote_specs(race,year,columns,book):
 stem=race['key'].rsplit('-'+str(race['year']),1)[0];prefix=RACE_PREFIX.get(stem)
 if race['key'].startswith('house-'):prefix='CNG'
 if race['key'].startswith('senate-'):
  prefix='USP' if ('partial' in race['key'] or 'special' in race['key']) else 'USS'
 if not prefix:return None
 cd=re.search(r'-cd(\d+)$',race['key']);district=int(cd[1]) if cd else None
 candidates=[c for c in columns if c.startswith(prefix) and not c.startswith('PR_')]
 def match(side):
  needle=norm(race[side+'Name']);matches=[]
  for _,entry in book.iterrows():
   col=entry.get('FIELD',entry.get('CONTEST',entry.get('CODE','')))
   if col not in candidates:continue
   dist=entry.get('DISTRICT','')
   if district is not None and str(dist).lstrip('0')!=str(district):continue
   name=norm(entry.get('NAME',''))
   if name and needle and (needle in name or name in needle):matches.append(col)
  matches=sorted(set(matches))
  if len(matches)==1:return matches[0]
  party=re.search(r'\(([A-Z]+)\)',race[side+'Name']);party=party[1] if party else ('D' if side=='dem' else 'R')
  codes={'D':'DEM','R':'REP','I':'IND','N':'NOP'};partycols=[c for c in candidates if c.startswith(prefix+codes.get(party,party))]
  if len(partycols)==1:return partycols[0]
  return None
 
 if prefix=='CNG' and district is None:
  dem=[c for c in candidates if c.startswith(prefix+'DEM')];rep=[c for c in candidates if c.startswith(prefix+'REP')]
  return dem,rep,[c for c in candidates if c not in dem+rep],None
 dem=match('dem');rep=match('rep')
 if not dem or not rep or dem==rep:return None
 others=[c for c in candidates if c not in [dem,rep] and not c.endswith('DIST')]
 return [dem],[rep],others,district

def race_block_votes(county,races):
 result={};audit={};dest=CACHE/'election-counties'
 for year in ['16','18','20','22','24']:
  p=dest/f'{county}-g{year}.pkl'
  if not p.exists():continue
  df=pd.read_pickle(p);book=pd.read_csv(CACHE/f'g{year}-codebook.csv',dtype=str,keep_default_na=False)
  for race in races:
   if str(race['year'])!='20'+year:continue
   spec=vote_specs(race,year,df.columns,book)
   if not spec:
    audit[race['key']]={'method':'precinct fallback','reason':'No matching block contest','sourceTotals':[0,0,0]};continue
   d,r,others,cd=spec;data=df
   if cd is not None:
    c='CNG_DIST' if 'CNG_DIST' in data else 'CDDIST'
    data=data[pd.to_numeric(data[c],errors='coerce')==cd]
   val=lambda col:pd.to_numeric(data[col],errors='coerce').fillna(0).to_numpy(dtype=np.int64)
   zero=np.zeros(len(data),dtype=np.int64)
   counts=np.column_stack([sum((val(c) for c in d),zero.copy()),sum((val(c) for c in r),zero.copy()),sum((val(c) for c in others),zero.copy())])
   if year in ['16','18','20']:
    result[race['key']]={bid:values for bid,values in zip(data['BLOCK20'],counts)}
   else:
    cross=pd.read_pickle(dest/f'{county}-g{year}-map.pkl');groups={str(k):v for k,v in cross.groupby('SRPREC')};blocks=defaultdict(lambda:np.zeros(3,dtype=np.int64))
    missing=[]
    for precinct,totals in zip(data['SRPREC'],counts):
     rows=groups.get(str(precinct))
     if rows is None:
      if any(totals):missing.append({'precinct':str(precinct),'votes':[int(n) for n in totals]})
      continue
     weights=pd.to_numeric(rows['PCTSRPREC'],errors='coerce').fillna(0).to_numpy();bids=rows['BLOCK_KEY'].tolist()
     for side,total in enumerate(totals):
      for bid,n in zip(bids,allocate(total,weights)):blocks[bid][side]+=n
    if missing:
     audit[race['key']]={'method':'precinct fallback','reason':'Incomplete registration crosswalk','sourceTotals':[0,0,0],'unmatched':missing};continue
    result[race['key']]=dict(blocks)
   audit[race['key']]={'method':'block allocation','sourceTotals':[int(n) for n in counts.sum(axis=0)]}
 return result,audit

def build_county(county,slug,name,pop,races,city_records,city_geoms):
 print('Building',name,flush=True)
 parents={};proj={};geoms={};trees={};ids={};sourceBG={};max_area_error=0
 for geo in GEO:
  directory=WEB/'data'/geo/'geometry';manifest=json.loads((directory/'manifest.json').read_text());inv,fwd=projection(manifest['projection']);proj[geo]=fwd
  records=json.loads((directory/f'precincts-{slug}.json').read_text())['records'];parents[geo]={r['county']+'|'+str(r['precinct']):dict(r) for r in records}
  ids[geo]=list(parents[geo]);geoms[geo]=[from_path(r['d'],inv) for r in records];trees[geo]=STRtree(geoms[geo])
  if geo=='CA-BG':sourceBG=parents[geo].copy()
 bgkeys=sorted(k for r in sourceBG.values() for k,v in r.items() if isinstance(v,(int,float)) and k not in ['inc_med'])
 statkeys=sorted(set(bgkeys+['pop20','vap20','pop20Adjusted','inc_medw','inc_medhh']))
 meta,_,wkb,fields=pyogrio.raw.read(CACHE/'blocks/tl_2020_06_tabblock20.shp',where=f"COUNTYFP20 = '{county}'",columns=['COUNTYFP20','GEOID20','HOUSING20'])
 fieldmap=dict(zip(meta['fields'],fields));blockids=fieldmap['GEOID20'];houses=fieldmap['HOUSING20'];blocks=from_wkb(wkb)
 if not len(blockids):raise RuntimeError('No blocks loaded for '+county)
 cities=STRtree(city_geoms);cityids=[c['id'] for c in city_records]
 atoms=[];atom_geoms=[];block_groups=defaultdict(list);parent_groups={g:defaultdict(list) for g in GEO}
 for bi,(bid,block) in enumerate(zip(blockids,blocks)):
  block=clean(transform(TO_M,block));start=len(atoms)
  for ca,part in partition(block,trees['CA'],geoms['CA'],ids['CA']):
   for bg,sub in partition(part,trees['CA-BG'],geoms['CA-BG'],ids['CA-BG']):
    for city,piece in partition(sub,cities,city_geoms,cityids):
     if piece.area<=1e-8:continue
     ca=ca or name+'|Unmapped census blocks';bg=bg or name+'|Unmapped census blocks'
     ident=bid+':'+hashlib.sha256((ca+'|'+bg+'|'+str(city)).encode()).hexdigest()[:16]
     a={'id':ident,'block':bid,'parents':{'CA':ca,'CA-BG':bg},'city':city,'polygons':ll_polys(piece),'stats':{},'votes':{},'estimated':len(polygons(piece))>1 or abs(piece.area-block.area)>max(.01,block.area*1e-8)}
     i=len(atoms);atoms.append(a);atom_geoms.append(piece);block_groups[bid].append(i)
     for g,k in a['parents'].items():parent_groups[g][k].append(i)
  indices=list(range(start,len(atoms)));areas=[atom_geoms[i].area for i in indices]
  if not indices:raise RuntimeError('Missing geography for block '+bid)
  area_error=abs(sum(areas)-block.area);max_area_error=max(max_area_error,area_error)
  if area_error>max(.01,block.length*.004,block.area*1e-8):raise RuntimeError('Overlay does not conserve block area: '+bid+' error '+str(area_error))
  counts=pop.loc[bid]
  for key in ['pop20','vap20','pop20Adjusted']:
   for i,v in zip(indices,allocate(counts[key],areas)):atoms[i]['stats'][key]=int(v)
  houseparts=allocate(int(houses[bi]),areas)
  for i,v in zip(indices,houseparts):atoms[i]['houses']=int(v)
  if bi and bi%10000==0:print(name,bi,'blocks',len(atoms),'atoms',flush=True)
 # Allocate published block-group analysis fields once to shared atoms. Census counts remain independent.
 for key,indices in parent_groups['CA-BG'].items():
  source=sourceBG.get(key,{})
  for field in statkeys:
   if field in ['pop20','vap20','pop20Adjusted','inc_medw','inc_medhh']:continue
   weights=[atoms[i]['houses'] if field.startswith('inc_') else atoms[i]['stats']['vap20'] if field.startswith(('edu_','cvap','vap')) else atoms[i]['stats']['pop20'] for i in indices]
   if not sum(weights):weights=[atom_geoms[i].area for i in indices]
   for i,n in zip(indices,allocate(source.get(field,0),weights)):atoms[i]['stats'][field]=int(n)
  for i in indices:
   hh=atoms[i]['stats'].get('inc_total',0);median=source.get('inc_med',0)
   atoms[i]['stats']['inc_medhh']=hh if median>0 else 0;atoms[i]['stats']['inc_medw']=hh*median
 block_votes,election_audit=race_block_votes(county,races)
 for racekey,values in block_votes.items():
  for bid,totals in values.items():
   indices=block_groups.get(bid)
   if not indices:
    if not any(totals):continue
    election_audit[racekey].setdefault('unlocatedBlocks',[]).append({'block':bid,'votes':[int(n) for n in totals]})
    indices=list(range(len(atoms)));areas=[atoms[i]['stats']['vap20'] for i in indices]
   else:areas=[atom_geoms[i].area for i in indices]
   sides=[allocate(int(total),areas) for total in totals]
   for n,i in enumerate(indices):
    votes=[int(side[n]) for side in sides]
    if any(votes):atoms[i]['votes'][racekey]=[n+old for n,old in zip(votes,atoms[i]['votes'].get(racekey,[0,0,0]))]
 # Preserve RDH's corrected Madera 2024 data and explicitly allocated fallbacks for unmatched contests.
 for race in races:
  key=race['key'];path=WEB/'data/CA'/key/f'votes-{slug}.json'
  if not path.exists():continue
  if key in block_votes and not (county=='039' and str(race['year'])=='2024'):continue
  records=json.loads(path.read_text())['records']
  election_audit[key]={'method':'precinct fallback','reason':election_audit.get(key,{}).get('reason','Corrected Madera 2024'),**({'unmatched':election_audit[key]['unmatched']} if election_audit.get(key,{}).get('unmatched') else {}),'sourceTotals':[sum(rec.get(side,0) for rec in records) for side in ['dem','rep','other']]}
  for a in atoms:a['votes'].pop(key,None)
  for rec in records:
   indices=parent_groups['CA'].get(rec['county']+'|'+str(rec['precinct']),[])
   if not indices:
    footprint=geoms['CA'][ids['CA'].index(rec['county']+'|'+str(rec['precinct']))]
    atomtree=STRtree(atom_geoms)
    indices=[int(i) for i in atomtree.query(footprint,predicate='intersects')]
    if not indices:indices=list(range(len(atoms)))
   weights=[atoms[i]['stats']['vap20'] for i in indices]
   if not sum(weights):weights=[atoms[i]['stats']['pop20'] for i in indices]
   if not sum(weights):weights=[atom_geoms[i].area for i in indices]
   sides=[allocate(rec.get(side,0),weights) for side in ['dem','rep','other']]
   for n,i in enumerate(indices):
    votes=[int(side[n]) for side in sides]
    if any(votes):atoms[i]['votes'][key]=[n+old for n,old in zip(votes,atoms[i]['votes'].get(key,[0,0,0]))]
 # Retain empty/shadowed legacy IDs for migration; they have no paintable footprint.
 for geo in GEO:
  for key in parents[geo]:parent_groups[geo].setdefault(key,[])
 summaries={};city_parents={g:defaultdict(set) for g in GEO}
 for geo in GEO:
  summaries[geo]=[]
  for key,indices in parent_groups[geo].items():
   rec=parents[geo].get(key,{'precinct':'Unmapped census blocks','county':name})
   # Reconstruct the exact partition footprint, so parent and child exports agree.
   footprint=union_all([atom_geoms[i] for i in indices]);rec['d']=paths(footprint,proj[geo])
   xys=transform(proj[geo],transform(TO_LL,footprint)).bounds;rec['bbox']=list(xys) if indices else rec['bbox'];rec['empty']=not bool(indices)
   for field in statkeys:rec[field]=sum(atoms[i]['stats'].get(field,0) for i in indices)
   rec['inc_med']=rec['inc_medw']/rec['inc_medhh'] if rec['inc_medhh'] else 0
   rec['atomCount']=len(indices);rec['atomFile']=f'data/block-v1/atoms/{slug}.json.gz'
   summaries[geo].append(rec)
   for i in indices:
    if atoms[i]['city']:city_parents[geo][atoms[i]['city']].add(key)
  write_json(OUT/geo/'geometry'/f'precincts-{slug}.json',{'records':summaries[geo]})
  for race in races:
   records=[]
   for rec in summaries[geo]:
    indices=parent_groups[geo][rec['county']+'|'+str(rec['precinct'])];values=[sum(atoms[i]['votes'].get(race['key'],[0,0,0])[side] for i in indices) for side in range(3)]
    if any(values):records.append({'county':rec['county'],'precinct':rec['precinct'],'dem':values[0],'rep':values[1],'other':values[2]})
   write_json(OUT/geo/race['key']/f'votes-{slug}.json',{'records':records})
 for a in atoms:
  a['stats']=[a['stats'].get(k,0) for k in statkeys];a.pop('houses',None)
 write_json(OUT/'atoms'/f'{slug}.json.gz',{'statKeys':statkeys,'atoms':atoms,'parents':{g:dict(groups) for g,groups in parent_groups.items()}},True)
 report={'buildRevision':3,'elections':election_audit,'precisionMetres':.001,'maxBlockAreaErrorSquareMetres':max_area_error,'county':county,'slug':slug,'blocks':len(blockids),'atoms':len(atoms),'population':sum(rec['pop20'] for rec in summaries['CA']),'adjustedPopulation':sum(rec['pop20Adjusted'] for rec in summaries['CA']),'cityParents':{g:{k:sorted(v) for k,v in cities.items()} for g,cities in city_parents.items()}}
 assert report['population']==int(pop.loc[blockids,'pop20'].sum())
 for g in GEO:
  assert sum(r['pop20'] for r in summaries[g])==report['population']
 write_json(OUT/'reports'/f'{slug}.json',report)
 print('Finished',name,len(atoms),'atoms',flush=True)


def finalize(slugs,races,city_records,city_geoms):
 reports=[json.loads((OUT/'reports'/f'{s}.json').read_text()) for s in slugs]
 for geo in GEO:
  old=WEB/'data'/geo;manifest=json.loads((old/'geometry/manifest.json').read_text());manifest['files']=[f'precincts-{s}.json' for s in slugs];manifest['dataset']=DATASET
  write_json(OUT/geo/'geometry/manifest.json',manifest)
  (OUT/geo/'geometry/counties.json').write_bytes((old/'geometry/counties.json').read_bytes())
  updated=[]
  for race in races:
   race=dict(race)
   totals=[0,0,0]
   for slug in slugs:
    for rec in json.loads((OUT/geo/race['key']/f'votes-{slug}.json').read_text())['records']:
     for i,side in enumerate(['dem','rep','other']):totals[i]+=rec[side]
   two=totals[0]+totals[1];margin=(totals[0]-totals[1])/two if two else 0
   race.update(margin=margin,winner='dem' if margin>0 else 'rep' if margin<0 else None,marginText=('D+' if margin>0 else 'R+')+str(round(abs(margin)*100)) if two else '—')
   race['manifest']=f'data/block-v1/{geo}/{race["key"]}/manifest.json';updated.append(race)
   write_json(OUT/geo/race['key']/'manifest.json',{'files':[f'votes-{s}.json' for s in slugs]})
  write_json(OUT/geo/'races.json',{'races':updated})
  inv,fwd=projection(manifest['projection']);citylist=[]
  for city,geom in zip(city_records,city_geoms):
   parents=sorted({p for report in reports for p in report['cityParents'][geo].get(city['id'],[])})
   if not parents:continue
   citylist.append({**city,'parents':parents,'d':paths(geom,fwd),'bbox':list(transform(fwd,transform(TO_LL,geom)).bounds)})
  write_json(OUT/geo/'cities.json',{'records':citylist})
 sources=json.loads((CACHE/'sources.json').read_text())
 write_json(OUT/'manifest.json',{'id':DATASET,'version':1,'counties':slugs,'population':sum(r['population'] for r in reports),'adjustedPopulation':sum(r['adjustedPopulation'] for r in reports),'blocks':sum(r['blocks'] for r in reports),'atoms':sum(r['atoms'] for r in reports),'sources':sources,'allocation':'Official block counts; published historical block election allocations; 2022/2024 SR-precinct registration-share crosswalks. Other fields allocated from existing ACS block-group data; geometric fragments use equal-area proportions. Madera 2024 preserves corrected RDH source. Fallback contests use existing precinct results with VAP weights; unlocated source-block placeholders are distributed within their county using VAP. Per-county audit records identify these estimates.'})

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--counties',nargs='*');parser.add_argument('--resume',action='store_true');args=parser.parse_args()
 for name in ['blocks','places']:
  dest=CACHE/name
  if not dest.exists():
   dest.mkdir();zipfile.ZipFile(CACHE/(name+'.zip')).extractall(dest)
 pop=source_tables();prepare_elections()
 meta,_,wkb,fields=pyogrio.raw.read(CACHE/'places/tl_2025_06_place.shp',columns=['GEOID','NAME','MTFCC'])
 cities=[];city_geoms=[]
 for gid,name,code,geom in zip(*fields,from_wkb(wkb)):
  if code=='G4110':cities.append({'id':gid,'name':name});city_geoms.append(clean(transform(TO_M,geom)))
 races=json.loads((WEB/'data/CA/races.json').read_text())['races'];mapping_county={}
 for p in sorted((WEB/'data/CA-BG/geometry').glob('precincts-*.json')):
  rec=json.loads(p.read_text())['records'][0];county=str(rec['precinct'])[2:5];mapping_county[p.stem.removeprefix('precincts-')]=(county,rec['county'])
 slugs=args.counties or list(mapping_county)
 for slug in slugs:
  if args.resume and (OUT/'reports'/f'{slug}.json').exists():
   if json.loads((OUT/'reports'/f'{slug}.json').read_text()).get('buildRevision')==3:continue
  county,name=mapping_county[slug];build_county(county,slug,name,pop,races,cities,city_geoms)
 finalize(slugs,races,cities,city_geoms)
