"""Explicitly refresh the small offline fixture from a completed Alpine build."""
from pathlib import Path
import gzip,json,shutil
import pandas as pd
ROOT=Path(__file__).resolve().parents[1]
source=ROOT/'web/data/block-v1';target=ROOT/'tests/fixtures/block-v1'
races=['president-2024','president-2020'];slug='alpine'
def read(p):return json.loads(p.read_text())
def write(p,value):
 p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value,separators=(',',':'),allow_nan=False))
report=read(source/'reports/alpine.json');assert report['buildRevision']==3
doc=json.loads(gzip.decompress((source/'atoms/alpine.json.gz').read_bytes()))
for atom in doc['atoms']:atom['votes']={key:value for key,value in atom['votes'].items() if key in races}
(target/'atoms').mkdir(parents=True,exist_ok=True)
with (target/'atoms/alpine.json.gz').open('wb') as raw:
 with gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as zipped:zipped.write(json.dumps(doc,separators=(',',':')).encode())
report['elections']={key:value for key,value in report['elections'].items() if key in races}
write(target/'reports/alpine.json',report)
manifest=read(source/'manifest.json')
manifest.update(counties=[slug],population=report['population'],adjustedPopulation=report['adjustedPopulation'],blocks=report['blocks'],atoms=report['atoms'],fixture=True)
write(target/'manifest.json',manifest)
parent_ids={}
for geo in ['CA','CA-BG']:
 geometry=read(source/geo/'geometry/manifest.json');geometry['files']=['precincts-alpine.json']
 write(target/geo/'geometry/manifest.json',geometry)
 for name in ['precincts-alpine.json','counties.json']:
  shutil.copyfile(source/geo/'geometry'/name,target/geo/'geometry'/name)
 write(target/geo/'cities.json',{'records':[city for city in read(source/geo/'cities.json')['records'] if any(parent.startswith('Alpine|') for parent in city['parents'])]})
 selected=[race for race in read(source/geo/'races.json')['races'] if race['key'] in races]
 write(target/geo/'races.json',{'races':selected})
 for race in selected:
  write(target/geo/race['key']/'manifest.json',{'files':['votes-alpine.json']})
  shutil.copyfile(source/geo/race['key']/'votes-alpine.json',target/geo/race['key']/'votes-alpine.json')
 original=read(ROOT/'web/data'/geo/'geometry/precincts-alpine.json')['records']
 parent_ids[geo]=[record['county']+'|'+str(record['precinct']) for record in original]
pop=pd.read_pickle(ROOT/'.cache/geodata/population.pkl')
blocks=sorted({atom['block'] for atom in doc['atoms']})
write(target/'source-counts.json',{'parentIds':parent_ids,'blocks':{bid:pop.loc[bid,['pop20','vap20','pop20Adjusted']].astype(int).tolist() for bid in blocks}})
print('Refreshed Alpine fixture with two audited presidential contests.')
